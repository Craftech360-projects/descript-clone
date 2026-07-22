import type { Edl } from './types.ts';

export interface RenderPlan {
  /**
   * Written to disk and passed via -filter_complex_script. Inlining this as an
   * argument breaks on Windows once the edit has a few hundred cuts: the graph
   * grows linearly with cut count and the command line caps at ~32k chars.
   */
  filterScript: string;
  /** ffmpeg args, with {SCRIPT} to be replaced by the filter script's path. */
  args: string[];
  segments: number;
}

export interface RenderOptions {
  input: string;
  output: string;
  /** Audio-only sources skip the video chain entirely. */
  hasVideo: boolean;
  /**
   * Absolute path to an ASS/SRT file to burn into the picture. Omit to render
   * clean video. Ignored when there is no video track to burn onto.
   */
  subtitlePath?: string;
  /**
   * Output speed multiplier. 1 (the default) emits the graph unchanged, so a
   * normal render is byte-identical to one from before speed existed.
   *
   * Callers must clamp this to [MIN_SPEED, MAX_SPEED] first — see clampSpeed in
   * doc.ts. 0 would emit `setpts=PTS/0`.
   */
  speed?: number;
  /**
   * The source's frame rate, used to re-number the kept frames into a gapless
   * output (see the select note below). Omit only when the source has no video.
   *
   * Falls back to ffmpeg's own FRAME_RATE constant, which a variable-frame-rate
   * source can report as 0 — so the caller should probe rather than guess.
   */
  fps?: number;
}

/**
 * Make a path safe to sit inside a filtergraph's subtitles=filename='...'.
 *
 * On Windows this is the difference between working and not. Verified against
 * ffmpeg 8.1: the drive colon stays special even INSIDE single quotes — the
 * plainly-quoted 'C:/x/y.ass' fails to parse, while 'C\:/x/y.ass' works. Paths
 * containing a space are fine once quoted.
 */
export function escapeSubtitlePath(path: string): string {
  return path
    .replace(/\\/g, '/') // ffmpeg takes forward slashes on Windows and they need no escaping
    .replace(/'/g, "'\\''") // close the quote, emit a literal ', reopen
    .replace(/:/g, '\\:');
}

/**
 * Compile an EDL into an ffmpeg invocation.
 *
 * Every segment gets a micro fade-in and fade-out. This is not polish — cutting
 * a waveform at an arbitrary sample leaves a step discontinuity, which is a
 * broadband click. A ~12ms fade is inaudible as a fade and removes the click.
 */
export function buildRenderPlan(edl: Edl, options: RenderOptions): RenderPlan {
  const { input, output, hasVideo, subtitlePath, speed = 1, fps } = options;
  const burnIn = Boolean(hasVideo && subtitlePath);
  // Float equality would be the wrong test on a number that arrives off the wire.
  const retime = Math.abs(speed - 1) > 1e-6;

  if (edl.keep.length === 0) {
    throw new Error('Cannot render an empty EDL: every word was deleted.');
  }

  const lines: string[] = [];

  // The anti-click fades, placed on the SOURCE clock rather than per segment.
  //
  // `enable` is what makes that possible: afade normally ramps once and then
  // holds its end value forever, which is useless when a stream needs 2N ramps.
  // Gated to its own window, each afade is bypassed everywhere else, so the
  // filters compose into one envelope down a single linear chain — 1 at rest,
  // ramping only across the 12ms either side of a cut.
  //
  // A segment shorter than two fades would fade in and immediately out, audibly
  // ducking a real word, so the fade shrinks to fit. A zero-length fade emits
  // nothing at all: `d=0` is a degenerate ramp, and the Cuts panel can ask for
  // one by setting fade to 0.
  const fades = edl.keep.flatMap((range) => {
    const fade = Math.min(edl.fadeMs / 1000, (range.end - range.start) / 2);
    if (fade <= 0) return [];
    const outStart = range.end - fade;
    return [
      `afade=t=in:st=${f(range.start)}:d=${f(fade)}:` +
        `enable='between(t,${f(range.start)},${f(range.start + fade)})'`,
      `afade=t=out:st=${f(outStart)}:d=${f(fade)}:enable='between(t,${f(outStart)},${f(range.end)})'`,
    ];
  });

  // ONE LINEAR PASS PER STREAM, NOT N BRANCHES. This is a memory bound, not a
  // style choice, and it is why exporting a long edit no longer kills the app.
  //
  // The obvious graph — a `trim`/`atrim` per kept range, spliced back together
  // with concat — makes ffmpeg fan every decoded frame out to N branches. concat
  // drains branch 0 to exhaustion before it reads branch 1, so branches 1..N-1
  // queue their frames in RAM and nothing bounds that queue. Measured on the
  // 885s 720p sample: 2.9 GB after 45 seconds with SIX cuts, still climbing, on
  // a render wanting tens of gigabytes. It did not fail — it took the machine
  // down with it. Audio did the same thing an order of magnitude cheaper, at
  // 1.3 GB. The same export now peaks at 324 MB, flat in the cut count.
  //
  // select/aselect decide frame by frame as the stream goes past, so exactly one
  // frame is ever in flight. setpts is what closes the holes they leave: N is
  // the output frame index (the consumed sample count for asetpts), so kept
  // frames are re-numbered consecutively. Without it the gaps stay, and the
  // picture freezes across every cut for as long as the cut removed.
  const keptRanges = edl.keep.map((r) => `between(t,${f(r.start)},${f(r.end)})`).join('+');

  const videoCut = hasVideo
    ? `[0:v]select='${keptRanges}',setpts=N/${fps && fps > 0 ? f(fps) : 'FRAME_RATE'}/TB`
    : '';

  // asetnsamples is the price of cutting audio with aselect, which keeps or drops
  // whole FRAMES — and a decoder hands out ~1024 samples at a time. 21ms of slop
  // per cut would quantise every edit point and walk audio off the picture; at 64
  // samples the cut lands within 1.3ms and the rendered length comes out exact.
  //
  // It goes AFTER the fades, and that ordering is worth 15x on a heavily cut
  // edit: re-framing multiplies the frame count by 16, and every filter
  // downstream pays that per frame. Ahead of the fades it costs 2N x 16, behind
  // them 2 x 16 — 905s against ~60s at 400 cuts. afade ramps sample by sample
  // inside whatever frame it is handed, so it does not care which side it is on.
  const audioCut =
    `[0:a]${fades.length > 0 ? `${fades.join(',')},` : ''}asetnsamples=n=64:p=0,` +
    `aselect='${keptRanges}',asetpts=N/SR/TB`;

  // What each stream passes through after the cut, in order. The order is
  // load-bearing twice over.
  //
  // Burn-in happens AFTER the cut, never before. The cues are timed against
  // the OUTPUT timeline (see toCues), so they only line up once the kept ranges
  // are spliced together. Burning onto the source first would drift every
  // caption by exactly the amount cut before it.
  //
  // Speed happens after burn-in, and that is what makes burned captions free.
  // The subtitles filter paints glyphs onto frames at their 1x timestamps; setpts
  // then rescales those frames' timestamps, and the pixels travel with the frame
  // they were painted on. So a caption stays welded to its word at any speed,
  // with no re-timing anywhere. Retiming the cues INSTEAD — the obvious approach
  // — would double-apply: scaled cues burned onto frames that then get scaled
  // again. Sidecar caption files get no such ride and do need scaling; that is
  // what scaleCues is for.
  const videoStages: string[] = [];
  if (hasVideo) {
    if (burnIn) videoStages.push(`subtitles=filename='${escapeSubtitlePath(subtitlePath!)}'`);
    // No `-r`: setpts rewrites timestamps rather than resampling, and forcing a
    // frame rate here would make the encoder duplicate or drop frames to hit it.
    if (retime) videoStages.push(`setpts=PTS/${f(speed)}`);
  }

  // atempo, not asetpts: asetpts would resample the audio and pitch it up like a
  // tape machine. atempo time-stretches and holds the pitch, which is what the
  // <video> element does in the preview (preservesPitch) — so what you heard
  // while editing is what lands in the file.
  //
  // One instance is enough only because MAX_SPEED is 2; see the note there.
  //
  // This lands after the fades rather than before, so a 12ms anti-click fade
  // comes out 10ms at 1.2x. Both are far below the ~20ms where a fade stops
  // being a de-click and starts being audible as a duck.
  const audioStages: string[] = [];
  if (retime) audioStages.push(`atempo=${f(speed)}`);

  // Each chain writes straight to the final label when nothing follows it, so a
  // plain 1x render carries no relabel hops it does not need.
  const vHead = videoStages.length > 0 ? '[vcut]' : '[outv]';
  const aHead = audioStages.length > 0 ? '[acut]' : '[outa]';

  if (hasVideo) lines.push(`${videoCut}${vHead};`);
  lines.push(`${audioCut}${aHead};`);
  if (videoStages.length > 0) lines.push(`[vcut]${videoStages.join(',')}[outv];`);
  if (audioStages.length > 0) lines.push(`[acut]${audioStages.join(',')}[outa];`);

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', input,
    '-filter_complex_script', '{SCRIPT}',
    ...(hasVideo ? ['-map', '[outv]'] : []),
    '-map', '[outa]',
    ...(hasVideo ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] : []),
    '-c:a', 'aac',
    '-b:a', '192k',
    output,
  ];

  // Every line is emitted with its terminator so the stages above can be composed
  // in any combination; the graph itself must not end with one.
  return { filterScript: lines.join('\n').replace(/;$/, ''), args, segments: edl.keep.length };
}

/** ffmpeg wants plain decimals, never exponential notation. */
function f(seconds: number): string {
  return seconds.toFixed(4);
}
