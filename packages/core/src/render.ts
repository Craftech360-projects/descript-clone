import type { Edl } from './types.ts';
import { outputDuration } from './edl.ts';
import { bedFadeOut } from './music.ts';
import { colorFilterStages, type Grade } from './color.ts';
import { frameFilterStages, type FrameRender } from './frame.ts';
import { punchFilterStage, type OutputMove } from './frame-track.ts';
import { overlayFilterLines, type OutputOverlay, type OverlayRenderInput } from './overlay.ts';

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
  /**
   * Absolute path to a directory of imported font files, handed to libass so a
   * burned caption can use a family that is NOT installed on the render machine.
   *
   * libass loads these ON TOP OF fontconfig, so the built-in families still
   * resolve through their Liberation aliases; this only ADDS the imported ones,
   * matched by the family name in each file's `name` table (which is why the ASS
   * Fontname must be that exact family — see fonts.ts). Ignored without burn-in.
   */
  fontsDir?: string;
  /**
   * A background-music bed mixed UNDER the finished program. Omit for no music,
   * so a project without one renders byte-identical to before this existed.
   *
   * The defining property (and what the user asked for): the music sits on the
   * OUTPUT timeline, NOT the source. It is added after the cut, after the burn,
   * and after the speed change, so it plays continuously across the edited,
   * re-timed result at its own natural rate — it is never chopped by the word
   * cuts and never sped up with the picture. See bgMusicMixLines.
   */
  bgMusic?: BgMusicRender;
  /**
   * Run the program audio through the Studio Sound voice chain. Omit (the
   * default) and the audio graph is emitted exactly as it was before the enhancer
   * existed. Applied before the music bed, so it never processes the bed — see
   * studioSoundStages.
   */
  studioSound?: boolean;
  /** The trained denoiser already ran on the input — see studioSoundStages. */
  denoised?: boolean;
  /**
   * A ready-made `loudnorm=...` stage from an export preset, or absent to leave
   * the level as mixed.
   *
   * Passed as the built filter rather than a number so packages/core keeps one
   * place that knows how loudnorm is spelt — see export-preset.ts.
   */
  loudness?: string | null;
  /**
   * Reframe the picture to a target resolution, cropping to fill it. Already
   * resolved to concrete pixels by the caller — resolveFrame returns null when the
   * setting would change nothing, and that null is why a project that never opens
   * the Frame panel emits no scale/crop at all. See frameFilterStages.
   */
  frame?: FrameRender;
  /**
   * The colour grade — a 3x3 matrix and a per-channel affine, already resolved
   * from the preset and the knobs by the caller. resolveColor returns null when
   * the grade is neutral, and that null is why a project which never opens the
   * Colour panel emits no colour filters at all. See colorFilterStages.
   */
  color?: Grade;
  /**
   * Animated push-ins over the finished frame — the marked-object follow. The
   * caller has already moved these onto the OUTPUT clock, because the filter
   * that applies them runs after the cut and there is no other clock there.
   * Omit, or pass no moves, and no zoompan is emitted at all.
   */
  punch?: PunchRender;
  /**
   * Images composited over the finished frame — the B-roll track. As with
   * `punch`, the caller has already moved these onto the OUTPUT clock, because
   * the filters that apply them run after the cut and there is no other clock
   * there. Omit, or pass no overlays, and no extra input or filter is emitted.
   */
  images?: ImagesRender;
}

/**
 * The image track, ready to emit: overlays on the output clock, the file behind
 * each one, and the three facts about the delivered stream that `overlay` and
 * `scale` cannot work out for themselves.
 *
 * The size is here rather than read off `frame` for exactly the reason
 * PunchRender carries its own: the two are independent. A project can place an
 * image without ever touching the Frame panel, and then resolveFrame returns
 * null (nothing to crop) while the compositor still has to be told what
 * rectangle those 0..1 box fractions are fractions OF.
 */
export interface ImagesRender {
  /** Overlays already mapped onto the output clock — see overlaysToOutput. */
  overlays: OutputOverlay[];
  /**
   * Absolute path on disk for each overlay's `assetId`.
   *
   * A lookup rather than a path per overlay, because the same picture placed at
   * four words is one file and one entry. An overlay whose asset is missing from
   * this map is SKIPPED rather than failing the render: the alternative is that
   * deleting an image from the library makes every project that ever used it
   * un-exportable.
   */
  paths: Record<string, string>;
  /** The delivered frame. Box fractions resolve against exactly this. */
  width: number;
  height: number;
  /**
   * The output frame rate. The still is generated at this rate, and a wrong
   * value shows up as a dissolve that steps rather than ramps. Probed, never
   * guessed — see overlayFilterLines.
   */
  fps: number;
}

/**
 * Pair each overlay with its file, dropping any whose asset has gone.
 *
 * Shared by both render plans so the "a missing image is skipped, not fatal"
 * rule has one implementation rather than two that can disagree.
 */
/**
 * The video lines for a chain that has images in the middle of it: the stages
 * before the composite, the composite, and the stages after.
 *
 * Shared by both render plans, which reach this point with the same three
 * pieces in hand and would otherwise each spell the label plumbing out.
 *
 * The `null` at the end is a RELABEL, not a no-op left in by accident. A
 * filtergraph cannot rename a pad by writing `[a][b]`; when nothing follows the
 * composite, the last overlay's output still has to be carried to `[outv]`, and
 * `null` is the video passthrough that does it for the cost of a copy that
 * ffmpeg elides anyway.
 */
function imageChainLines(
  images: OverlayRenderInput[],
  head: string,
  before: string[],
  after: string[],
  render: ImagesRender,
  firstInputIndex: number,
): { lines: string[]; inputArgs: string[] } {
  const lines: string[] = [];

  let base = head;
  if (before.length > 0) {
    lines.push(`${head}${before.join(',')}[vpre];`);
    base = '[vpre]';
  }

  const plan = overlayFilterLines(images, base, render, firstInputIndex);
  lines.push(...plan.lines);
  lines.push(after.length > 0 ? `${plan.outLabel}${after.join(',')}[outv];` : `${plan.outLabel}null[outv];`);
  return { lines, inputArgs: plan.inputArgs };
}

function overlayInputs(images: ImagesRender | undefined, hasVideo: boolean): OverlayRenderInput[] {
  if (!hasVideo || !images) return [];
  return images.overlays.flatMap((overlay) => {
    const input = images.paths[overlay.assetId];
    return input ? [{ overlay, input }] : [];
  });
}

/**
 * The animated punch, ready to emit: moves on the output clock, plus the two
 * facts about the stream that zoompan cannot work out for itself.
 *
 * The size is here rather than read off `frame` because the two are independent:
 * a project can mark a push-in without ever touching the Frame panel, and then
 * resolveFrame returns null (nothing to crop) while zoompan still has to be told
 * what shape to hand back.
 */
export interface PunchRender {
  /** Moves already mapped onto the output clock — see movesToOutput. */
  moves: OutputMove[];
  /** The delivered frame. zoompan is asked for exactly this size back. */
  width: number;
  height: number;
  /**
   * The output frame rate. zoompan GENERATES its timestamps from this rather
   * than carrying the input's through, so a wrong value here is a video of the
   * wrong LENGTH rather than one that merely looks wrong. Probed, never guessed.
   */
  fps: number;
}

/**
 * A background-music bed for a render. The music is a separate ffmpeg input,
 * gained, trimmed to a length on the OUTPUT clock, faded, and amix'd under the
 * program — see bgMusicMixLines.
 */
export interface BgMusicRender {
  /** The music file, passed to ffmpeg as its own `-i` input. */
  input: string;
  /** Linear gain applied to the music before the mix, e.g. 0.5 for half volume. */
  volume: number;
  /**
   * How long the music plays, in OUTPUT seconds (the finished file's clock). The
   * caller resolves this to a concrete number — the min of any user-set length,
   * the music file's own duration, and the program length — so the render layer
   * always knows exactly where the bed ends and can fade it there.
   */
  durationSec: number;
  /**
   * Seconds of fade-out at the music's end, so a TRIMMED bed does not cut hard.
   * Omit for the default, which is a ramp when the bed stops before the program
   * and nothing at all when it plays to the last frame — see bedFadeOut.
   */
  fadeOutSec?: number;
  /**
   * The finished program's length on the output clock, in seconds. Only the fade
   * needs it: a bed that reaches this is ending because the video ended, and must
   * not be ramped out. Omit and the bed is treated as trimmed, which is the old
   * behaviour and always fades.
   */
  programSec?: number;
  /**
   * Loop the file to fill `durationSec`. Without this a bed shorter than the
   * requested length simply stops early; with it the track repeats end-to-end
   * (via `-stream_loop -1` on the input) until the trim cuts it at durationSec.
   * This is what lets a 30s track underscore a 5-minute video.
   */
  loop?: boolean;
}

/**
 * The filtergraph lines that mix a music bed under the finished program audio.
 *
 * `programLabel` is the pad carrying the completed program audio (post-cut,
 * post-speed) — this consumes it and produces the final `[outa]`. `musicIndex`
 * is the music file's ffmpeg input index.
 *
 * Why the resamples and the amix options:
 *  - amix requires its inputs to agree on sample rate and format; the program
 *    and an arbitrary music file rarely do, so both are normalised to 48k stereo
 *    fltp first. On the sequence path the program is already 48k stereo, so that
 *    resample is a no-op there rather than a second conversion.
 *  - `duration=first` ties the output length to the PROGRAM, not the music: a bed
 *    longer than the program is cut off at the program's end, and a shorter one
 *    simply stops while the program plays on.
 *  - `normalize=0` is load-bearing. amix's default divides every input by the
 *    input count, which would silently halve the voice the moment music is added.
 *    With it off, the program stays at unity and only the music carries the gain
 *    the user dialled in.
 */
function bgMusicMixLines(
  programLabel: string,
  musicIndex: number,
  bg: BgMusicRender,
  /**
   * The export preset's loudnorm stage, applied AFTER the bed is mixed in.
   *
   * It cannot run before. Normalising the voice and then summing music on top
   * gives a file whose integrated loudness is whatever the sum happens to be —
   * measured on this project, a -14 target landed at -15.6 because the bed was
   * added after the measurement. The target is a claim about the DELIVERED file,
   * so it has to be the last thing that touches the mix.
   */
  loudness?: string | null,
): string[] {
  const vol = Math.max(0, bg.volume);
  const dur = bg.durationSec;
  // Zero when the bed plays to the last frame: there is nothing after it to ease
  // into, and ramping there just deletes the tail of the mix. See bedFadeOut.
  // Infinity, not 0, for the missing case: an unknown program is one the bed
  // cannot be shown to reach, so it stays trimmed and keeps its ramp.
  const fade = bedFadeOut(dur, bg.programSec ?? Infinity, bg.fadeOutSec);

  const music = [
    `volume=${vol.toFixed(3)}`,
    // Trim to the resolved output length and rebase its timestamps to zero, so
    // the bed starts with the program rather than at some inherited PTS.
    `atrim=0:${f(dur)}`,
    `asetpts=N/SR/TB`,
    // A hair of fade-in kills the click of starting mid-waveform at t=0.
    `afade=t=in:st=0:d=${f(Math.min(0.01, dur))}`,
  ];
  if (fade > 0) music.push(`afade=t=out:st=${f(dur - fade)}:d=${f(fade)}`);
  music.push('aresample=48000', 'aformat=sample_fmts=fltp:channel_layouts=stereo');

  return [
    `${programLabel}aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[bgprog];`,
    `[${musicIndex}:a]${music.join(',')}[bgm];`,
    // amix sums, it does not limit: the bed's energy lands on top of a program
    // that Studio Sound may already have normalised to TP -1.5, so a loud bed can
    // push the sum past full scale. alimiter catches only those peaks — below the
    // ceiling it is transparent, so a quiet bed sounds exactly as it did.
    // loudnorm sits between the sum and the limiter: it needs the finished mix to
    // measure, and the limiter stays last so it can still catch a stray peak.
    `[bgprog][bgm]amix=inputs=2:duration=first:normalize=0` +
      `${loudness ? `,${loudness},aresample=48000` : ''}` +
      `,alimiter=limit=-1.0dB:level=disabled[outa];`,
  ];
}

/**
 * The Studio Sound voice chain: the filters that turn a raw room recording into
 * something that sounds recorded on purpose.
 *
 * Applied to the PROGRAM audio only — after the cut, before the music bed — so
 * the enhancer never denoises or compresses the bed along with the voice.
 *
 * Stage by stage, and why each is where it is:
 *  - `highpass` FIRST, not after the denoiser. Rumble, handling noise and HVAC
 *    all live under ~85Hz and carry real energy; removing them up front means the
 *    denoiser and the compressor are not spending their budget chasing something
 *    a 2-pole filter deletes for free.
 *  - `afftdn` at the default noise floor. `nf` is the level BELOW WHICH audio is
 *    assumed to be noise, and dialogue keeps a lot of meaning down there —
 *    consonants, word tails, breath. Pushing nf up towards -20 measurably eats
 *    the voice itself and produces the watery, warbling artifact people recognise
 *    instantly as "over-processed". `tn=1` tracks the noise profile as it changes
 *    rather than fixing it from the first frame.
 *  - `deesser` before the compressor, so the compressor is not pumping on
 *    sibilance the de-esser is about to remove anyway.
 *  - Two `equalizer` bells: a dip at 220Hz (the "mud" a close mic and a small
 *    room both add) and a lift at 3.2kHz (presence — where consonants live and
 *    intelligibility comes from). This is the EQ the panel promises.
 *  - `acompressor`, not `compand`. compand with a zero attack makes the gain
 *    follow the sample envelope instantaneously, which distorts the waveform
 *    rather than compressing it; acompressor has a real attack/release and a
 *    makeup gain.
 *  - `loudnorm` last, to the -16 LUFS / -1.5 dBTP that every speech platform
 *    targets — so the export lands at a sane level regardless of how the source
 *    was recorded.
 *  - `aresample=48000` is NOT optional. loudnorm runs its internals at 192kHz and
 *    emits at that rate; left alone it propagates to the encoder, and AAC then
 *    silently lands on 96kHz. Verified against ffmpeg 8.1. The music path happens
 *    to resample anyway, so without this the bug appears only on music-free
 *    renders — which is exactly the sort of thing that ships.
 */
export function studioSoundStages(loudness?: string | null, alreadyDenoised = false): string[] {
  return [
    'highpass=f=85',
    // Skipped when the trained denoiser has already run: afftdn would be
    // subtracting a noise estimate from audio that no longer has that noise, and
    // the pair audibly over-processes. The rest of the chain still earns its
    // place — the model cleans, it does not shape.
    ...(alreadyDenoised ? [] : ['afftdn=nr=12:nf=-30:tn=1']),
    'deesser=i=0.35',
    'equalizer=f=220:t=q:w=1.0:g=-2',
    'equalizer=f=3200:t=q:w=1.2:g=3',
    // Unity makeup after a denoise pass. The model leaves near-silence between
    // words, and makeup gain on near-silence is amplified artefacts — measured,
    // this was most of why a cleaned export scored barely better than an
    // uncleaned one. `makeup=1` IS unity: acompressor's range is [1, 64] and 0
    // is rejected outright, which is a render that fails rather than one that
    // sounds wrong.
    alreadyDenoised
      ? 'acompressor=threshold=-18dB:ratio=2.5:attack=8:release=180:makeup=1'
      : 'acompressor=threshold=-18dB:ratio=3:attack=8:release=180:makeup=2',
    // -16 is the speech-broadcast number and the right default for a voice. When
    // an export preset names a target instead, THAT one runs here rather than
    // after — two loudnorm passes in one chain is not twice as normalised, it is
    // one pass measuring a signal the other already moved.
    loudness ?? 'loudnorm=I=-16:TP=-1.5:LRA=11',
    'aresample=48000',
  ];
}

/**
 * Loudness on its own, for an export that names a destination without asking for
 * the voice chain.
 *
 * Normalisation used to live only inside studioSoundStages, so the only way to
 * hit a platform's target was to accept denoise, de-essing, EQ and compression
 * with it. Those are a creative choice; arriving at the right level is not.
 */
export function loudnessOnlyStages(loudness: string): string[] {
  // aresample for the same reason it is in the chain above: loudnorm leaves the
  // stream at 192kHz and AAC then silently lands on 96kHz.
  return [loudness, 'aresample=48000'];
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
  const { input, output, hasVideo, subtitlePath, speed = 1, fps, fontsDir, bgMusic, frame, color } =
    options;
  const burnIn = Boolean(hasVideo && subtitlePath);
  // null unless there is a move worth animating — see punchFilterStage, which
  // also refuses an unknown frame rate rather than guessing one.
  const punchStage = hasVideo && options.punch ? punchFilterStage(options.punch.moves, options.punch, options.punch.fps) : null;
  // With a music bed the program audio is an intermediate that the mix consumes;
  // without one it writes straight to the final [outa] as it always did.
  const programLabel = bgMusic ? '[aprog]' : '[outa]';
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
  // Split in two by where the images go, rather than one list: an overlay needs
  // a second INPUT, so it cannot live inside a comma-joined chain the way every
  // other stage can. With no images the two halves are concatenated back into
  // exactly the chain this emitted before overlays existed — see `flatStages`.
  const videoStages: string[] = [];
  const postImageStages: string[] = [];
  if (hasVideo) {
    // Reframing comes FIRST, and specifically before burn-in. Captions are placed
    // as a fraction of the OUTPUT frame and libass rasterises them at its size, so
    // burning before the crop would paint them at the source's shape and then cut
    // the edges off — a caption centred in a 16:9 is not centred in the 9:16 taken
    // out of it, and one near the bottom is simply gone. Cropping first means
    // every glyph is placed and scaled against the frame that ships.
    if (frame) videoStages.push(...frameFilterStages(frame));
    // The push-in rides immediately behind the reframe, and that pairing is the
    // whole model: the static crop decides what the delivered frame IS, and this
    // pushes into that finished frame. See frame-track.ts for why it can only
    // ever push in — pad's offsets are configuration-time, so an animated
    // letterbox does not exist to be emitted.
    //
    // Before the burn for the same reason the crop is: captions belong to the
    // delivered frame and must stay put and legible while the picture moves
    // under them. Burning first would magnify and then crop the text away.
    if (punchStage) videoStages.push(punchStage);
    // The grade sits between the crop and the burn, and both sides of that are
    // deliberate.
    //
    // After the crop, because it then works on the pixels that ship rather than
    // on a picture whose edges are about to be thrown away.
    //
    // Before the burn, and that one is not a preference. A grade must not tint
    // the captions — warming a scene should not turn white text amber — and it
    // is also the ONLY ordering the preview can match: in the monitor the filter
    // is on the <video> and the caption layer is a sibling painted over it, so
    // burning first here would show the user a caption that comes out a
    // different colour in the file.
    if (color) videoStages.push(...colorFilterStages(color));
    // ── everything from here composites ON TOP of the graded frame ───────────
    //
    // The image track sits between the grade and the burn, and both sides of
    // that are deliberate — the same argument the grade itself makes one line
    // above, pointed one layer further out.
    //
    // AFTER the grade, because that is the only ordering the preview can match.
    // In the monitor the grade is an SVG filter on the <video> and the image is
    // a sibling element painted over it, so an <img> is necessarily ungraded;
    // compositing before the grade here would tint every insert in the file and
    // leave it untinted on screen.
    //
    // BEFORE the burn, so captions stay legible on top of a cutaway rather than
    // being hidden by it. A caption belongs to the delivered frame, and a
    // full-frame image is content within that frame, not a replacement for it.
    if (burnIn) {
      // fontsdir is a second value in the same single-quoted filter-arg context
      // as filename, so it takes the identical escaping. Appended only when set,
      // to keep a project that uses no imported font byte-identical to before.
      const dir = fontsDir ? `:fontsdir='${escapeSubtitlePath(fontsDir)}'` : '';
      postImageStages.push(`subtitles=filename='${escapeSubtitlePath(subtitlePath!)}'${dir}`);
    }
    // No `-r`: setpts rewrites timestamps rather than resampling, and forcing a
    // frame rate here would make the encoder duplicate or drop frames to hit it.
    //
    // After the images for the same reason it is after the burn: the compositor
    // paints pixels onto frames at their 1x timestamps and setpts then rescales
    // those frames, so an insert stays welded to its word at any speed with no
    // re-timing anywhere. Retiming the overlay windows instead would
    // double-apply.
    if (retime) postImageStages.push(`setpts=PTS/${f(speed)}`);
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
  // Before atempo: the enhancer's compressor and loudness measurement want the
  // voice at its natural rate, and atempo does not change level enough to undo
  // the normalisation.
  /**
   * Where the loudness target runs depends on whether there is a bed.
   *
   * With music, normalising here would measure the voice ALONE and the bed would
   * then be summed on top — so the delivered file misses the target by however
   * loud the bed is. Measured: a -14 target landed at -15.6. With a bed the
   * stage moves into the mix chain instead; see bgMusicMixLines.
   */
  const loudnessAfterMix = Boolean(options.loudness && bgMusic);
  const programLoudness = loudnessAfterMix ? null : options.loudness;

  if (options.studioSound) audioStages.push(...studioSoundStages(programLoudness, options.denoised));
  else if (programLoudness) audioStages.push(...loudnessOnlyStages(programLoudness));
  if (retime) audioStages.push(`atempo=${f(speed)}`);

  // With no images the halves rejoin into one chain, in the order they were in
  // before the split — so a project that places no image emits the identical
  // graph it always did.
  const imageInputs = overlayInputs(options.images, hasVideo);
  const flatStages = [...videoStages, ...postImageStages];
  // Images take the LAST input indices — after the source and after any music —
  // so adding them shifts nothing that already existed. bgMusicMixLines is still
  // handed a hard 1 below, and that stays true only because of this ordering.
  const imageInputIndex = 1 + (bgMusic ? 1 : 0);

  // Each chain writes straight to the final label when nothing follows it, so a
  // plain 1x render carries no relabel hops it does not need. Images need a base
  // to composite onto even when no stage precedes them, which is the one case
  // where the cut cannot write to [outv] despite `flatStages` being empty.
  const vHead = imageInputs.length > 0 || flatStages.length > 0 ? '[vcut]' : '[outv]';
  const aHead = audioStages.length > 0 ? '[acut]' : programLabel;

  const imageChain =
    imageInputs.length > 0
      ? imageChainLines(imageInputs, '[vcut]', videoStages, postImageStages, options.images!, imageInputIndex)
      : null;

  if (hasVideo) lines.push(`${videoCut}${vHead};`);
  lines.push(`${audioCut}${aHead};`);
  if (imageChain) {
    lines.push(...imageChain.lines);
  } else if (flatStages.length > 0) {
    lines.push(`[vcut]${flatStages.join(',')}[outv];`);
  }
  if (audioStages.length > 0) lines.push(`[acut]${audioStages.join(',')}${programLabel};`);
  // The music bed rides on top of the finished program: input index 1, since the
  // single source is input 0. The program length is filled in here rather than
  // asked of the caller — the EDL and the speed are what decide it, and both are
  // already in hand, so the two cannot disagree.
  if (bgMusic) {
    lines.push(
      ...bgMusicMixLines(
        programLabel,
        1,
        { programSec: outputDuration(edl, speed), ...bgMusic },
        loudnessAfterMix ? options.loudness : null,
      ),
    );
  }

  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    '-i', input,
    // -stream_loop is an INPUT option, so it must sit just before this -i. -1
    // loops forever; the atrim in the mix caps it at durationSec, so "forever"
    // only ever means "until the bed's end".
    ...(bgMusic ? [...(bgMusic.loop ? ['-stream_loop', '-1'] : []), '-i', bgMusic.input] : []),
    // Last, so every index above keeps the number it already had. Each image
    // carries its own -loop/-framerate/-t, which are INPUT options and must sit
    // immediately before their own -i — the same rule -stream_loop follows.
    ...(imageChain?.inputArgs ?? []),
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

// ── multi-clip sequences ───────────────────────────────────────────────────────

/** One source file feeding a sequence render, aligned with the EDL's clips. */
export interface SequenceRenderClip {
  input: string;
  /** This clip's own source frame rate, for the frame renumber. Video only. */
  fps?: number;
  /**
   * Where this clip begins in its file, in seconds (≡ 0 when absent). Added to
   * every kept range before the select, so a clip that is a sub-window of its
   * file — the product of a split, where two clips share one file — reads the
   * right frames. Two split halves are two inputs of the SAME file, each keeping
   * its own window.
   */
  sourceStart?: number;
}

export interface SequenceRenderOptions {
  /** One per clip, in the SAME order as edl.clips — index i is ffmpeg input i. */
  clips: SequenceRenderClip[];
  output: string;
  hasVideo: boolean;
  /** Canonical output frame size every clip is scaled-and-padded to fit. */
  width: number;
  height: number;
  /** Canonical output frame rate every clip is resampled to. Video only. */
  fps: number;
  subtitlePath?: string;
  speed?: number;
  fontsDir?: string;
  /** A music bed mixed under the joined program — see RenderOptions.bgMusic. */
  bgMusic?: BgMusicRender;
  /**
   * Run the program audio through the Studio Sound voice chain. Omit (the
   * default) and the audio graph is emitted exactly as it was before the enhancer
   * existed. Applied before the music bed, so it never processes the bed — see
   * studioSoundStages.
   */
  studioSound?: boolean;
  /** The trained denoiser already ran on the input — see studioSoundStages. */
  denoised?: boolean;
  /**
   * A ready-made `loudnorm=...` stage from an export preset, or absent to leave
   * the level as mixed.
   *
   * Passed as the built filter rather than a number so packages/core keeps one
   * place that knows how loudnorm is spelt — see export-preset.ts.
   */
  loudness?: string | null;
  /**
   * Reframe the picture to a target resolution, cropping to fill it. Already
   * resolved to concrete pixels by the caller — resolveFrame returns null when the
   * setting would change nothing, and that null is why a project that never opens
   * the Frame panel emits no scale/crop at all. See frameFilterStages.
   */
  frame?: FrameRender;
  /**
   * The colour grade, applied ONCE to the joined stream rather than per clip.
   * One project is one look; a per-clip grade would be a different feature with
   * its own per-clip document state. Absent = the picture's values are untouched.
   */
  color?: Grade;
  /**
   * Animated push-ins, applied ONCE to the joined stream — the moves are marked
   * against the project's global timeline, which is exactly what concat produces.
   * Its `fps` must be the canonical output rate the clips were resampled to, not
   * any one clip's.
   */
  punch?: PunchRender;
  /**
   * Images composited over the joined stream — once, after the concat, for the
   * same reason the grade is applied once: the overlay windows are addressed
   * against the project's global timeline, and after concat that is the only
   * timeline there is. See RenderOptions.images.
   */
  images?: ImagesRender;
}

/**
 * Compile a multi-clip EDL into one ffmpeg invocation that stitches several
 * source files into a single output.
 *
 * The shape is: cut each clip on its OWN timeline with the same memory-safe
 * select/aselect pass buildRenderPlan uses, normalise each to a common frame
 * size / rate / audio format, then join them with the concat FILTER, and finally
 * burn captions and apply speed once on the joined stream.
 *
 * Why concat is safe here when buildRenderPlan spends a long comment avoiding it:
 * that blowup came from fanning ONE decoded stream into N `trim` branches, where
 * concat drained branch 0 while branches 1..N buffered unboundedly. Here each
 * concat input is a DIFFERENT file's single linear select chain — one frame in
 * flight per input, pulled in sequence — and the input count is the number of
 * CLIPS (a handful), not the number of cuts. The per-clip cut stays linear.
 */
export function buildSequenceRenderPlan(edl: Edl, options: SequenceRenderOptions): RenderPlan {
  const { clips, output, hasVideo, width, height, fps, subtitlePath, speed = 1, fontsDir, bgMusic } =
    options;
  const burnIn = Boolean(hasVideo && subtitlePath);
  const retime = Math.abs(speed - 1) > 1e-6;
  // With a music bed the joined program audio is an intermediate the mix consumes.
  const programLabel = bgMusic ? '[aprog]' : '[outa]';

  if (edl.keep.length === 0) {
    throw new Error('Cannot render an empty EDL: every word was deleted.');
  }
  if (!edl.clips || edl.clips.length === 0) {
    throw new Error('buildSequenceRenderPlan needs an EDL with clip metadata.');
  }

  const lines: string[] = [];
  const vLabels: string[] = [];
  const aLabels: string[] = [];

  edl.clips.forEach((clip, i) => {
    // The kept ranges that live in this clip, moved onto its own file timeline.
    // A range belongs to the clip whose window its start falls in — ranges never
    // straddle a seam, so the start decides the whole range. `sourceStart` shifts
    // local time onto the real file, so a split half selects its own window
    // rather than the file's first seconds.
    const srcStart = clips[i]?.sourceStart ?? 0;
    const local = edl.keep
      .filter((r) => r.start >= clip.offset && r.start < clip.offset + clip.sourceDuration)
      .map((r) => ({ start: r.start - clip.offset + srcStart, end: r.end - clip.offset + srcStart }));
    if (local.length === 0) return; // this clip is entirely cut — it drops out

    const expr = local.map((r) => `between(t,${f(r.start)},${f(r.end)})`).join('+');
    const srcFps = clips[i]?.fps;

    if (hasVideo) {
      // select cuts; setpts renumbers kept frames against the clip's OWN rate;
      // then scale+pad letterboxes into the canonical frame and fps unifies the
      // rate — both mandatory, because concat rejects clips that disagree on
      // size, SAR, rate, or pixel format.
      const vRenum = srcFps && srcFps > 0 ? f(srcFps) : 'FRAME_RATE';
      lines.push(
        `[${i}:v]select='${expr}',setpts=N/${vRenum}/TB,` +
          `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(${width}-iw)/2:(${height}-ih)/2,` +
          `setsar=1,fps=${f(fps)},format=yuv420p[v${i}];`,
      );
      vLabels.push(`[v${i}]`);
    }

    // The anti-click fades, on this clip's local clock (see buildRenderPlan).
    const fades = local.flatMap((range) => {
      const fade = Math.min(edl.fadeMs / 1000, (range.end - range.start) / 2);
      if (fade <= 0) return [];
      const outStart = range.end - fade;
      return [
        `afade=t=in:st=${f(range.start)}:d=${f(fade)}:` +
          `enable='between(t,${f(range.start)},${f(range.start + fade)})'`,
        `afade=t=out:st=${f(outStart)}:d=${f(fade)}:enable='between(t,${f(outStart)},${f(range.end)})'`,
      ];
    });
    lines.push(
      `[${i}:a]${fades.length > 0 ? `${fades.join(',')},` : ''}asetnsamples=n=64:p=0,` +
        `aselect='${expr}',asetpts=N/SR/TB,aresample=48000,` +
        `aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}];`,
    );
    aLabels.push(`[a${i}]`);
  });

  const n = aLabels.length;

  // Interleave the labels the way concat wants them: v,a,v,a,… when there is
  // video, else just the audio labels.
  const concatInputs = hasVideo
    ? vLabels.flatMap((v, i) => [v, aLabels[i]]).join('')
    : aLabels.join('');

  // If nothing follows the join, concat writes straight to the output labels, so
  // a plain 1x render with no burn carries no relabel hops.
  // Resolved before the label decision, not inside the block below: a project
  // whose ONLY video change is a push-in still needs the [vc] relabel, and
  // testing `Boolean(options.punch)` instead would claim one for a punch that
  // turned out to have nothing to animate.
  const punchStage = hasVideo && options.punch
    ? punchFilterStage(options.punch.moves, options.punch, options.punch.fps)
    : null;
  const imageInputs = overlayInputs(options.images, hasVideo);
  // Images take the LAST input indices — after every clip and after any music —
  // so the clip indices above and bgMusicMixLines' `clips.length` below both
  // keep the numbers they already had.
  const imageInputIndex = clips.length + (bgMusic ? 1 : 0);
  let imageChain: { lines: string[]; inputArgs: string[] } | null = null;
  const wantsVideoStage =
    hasVideo &&
    (burnIn ||
      retime ||
      Boolean(options.frame) ||
      Boolean(options.color) ||
      Boolean(punchStage) ||
      imageInputs.length > 0);
  const vJoin = hasVideo ? (wantsVideoStage ? '[vc]' : '[outv]') : '';
  const wantsAudioStage = retime || options.studioSound;
  const aJoin = wantsAudioStage ? '[ac]' : programLabel;

  lines.push(`${concatInputs}concat=n=${n}:v=${hasVideo ? 1 : 0}:a=1${vJoin}${aJoin};`);

  // Burn-in then speed, once, on the joined stream — identical ordering and
  // reasoning to buildRenderPlan: cues are timed to the output, and glyphs must
  // ride the frames the speed change rescales.
  if (wantsVideoStage) {
    const stages: string[] = [];
    const postImageStages: string[] = [];
    // Reframing before burn-in, exactly as on the single-input path. Note it runs
    // AFTER the per-clip normalise above, so a stitch of mismatched sources is one
    // known rectangle by the time it is cropped — the clips never have to agree
    // with the target frame, only with each other.
    if (options.frame) stages.push(...frameFilterStages(options.frame));
    // The push-in, on the joined stream — the moves are marked against the
    // project's global timeline, and after concat that is the only timeline
    // there is. Same position in the chain as on the single-input path.
    if (punchStage) stages.push(punchStage);
    // Crop, then grade, then composite images, then burn — identical ordering
    // and reasoning to buildRenderPlan. Once, here, on the joined stream:
    // grading each clip separately would cost the conversion N times and still
    // produce one look, and an image window addressed against the global
    // timeline has no meaning on any single clip's clock.
    if (options.color) stages.push(...colorFilterStages(options.color));
    if (burnIn) {
      const dir = fontsDir ? `:fontsdir='${escapeSubtitlePath(fontsDir)}'` : '';
      postImageStages.push(`subtitles=filename='${escapeSubtitlePath(subtitlePath!)}'${dir}`);
    }
    if (retime) postImageStages.push(`setpts=PTS/${f(speed)}`);

    if (imageInputs.length > 0) {
      imageChain = imageChainLines(
        imageInputs,
        '[vc]',
        stages,
        postImageStages,
        options.images!,
        imageInputIndex,
      );
      lines.push(...imageChain.lines);
    } else {
      lines.push(`[vc]${[...stages, ...postImageStages].join(',')}[outv];`);
    }
  }
  // Same rule as the single-clip path: with a bed, the target has to be measured
  // on the finished sum, not on the voice before the bed is added.
  const seqLoudnessAfterMix = Boolean(options.loudness && bgMusic);
  const seqProgramLoudness = seqLoudnessAfterMix ? null : options.loudness;

  if (wantsAudioStage) {
    const aStages: string[] = [];
    if (options.studioSound) aStages.push(...studioSoundStages(seqProgramLoudness, options.denoised));
    else if (seqProgramLoudness) aStages.push(...loudnessOnlyStages(seqProgramLoudness));
    if (retime) aStages.push(`atempo=${f(speed)}`);
    lines.push(`[ac]${aStages.join(',')}${programLabel};`);
  }
  // The music bed rides on top of the joined program: its input index is the
  // clip count, since the clips occupy inputs 0..n-1. programSec as above.
  if (bgMusic) {
    lines.push(
      ...bgMusicMixLines(
        programLabel,
        clips.length,
        { programSec: outputDuration(edl, speed), ...bgMusic },
        seqLoudnessAfterMix ? options.loudness : null,
      ),
    );
  }

  const inputs = clips.flatMap((c) => ['-i', c.input]);
  const args = [
    '-hide_banner',
    '-loglevel', 'error',
    '-y',
    ...inputs,
    // -stream_loop is an INPUT option, so it must sit just before this -i. -1
    // loops forever; the atrim in the mix caps it at durationSec, so "forever"
    // only ever means "until the bed's end".
    ...(bgMusic ? [...(bgMusic.loop ? ['-stream_loop', '-1'] : []), '-i', bgMusic.input] : []),
    // Last, so every index above keeps the number it already had — see
    // imageInputIndex.
    ...(imageChain?.inputArgs ?? []),
    '-filter_complex_script', '{SCRIPT}',
    ...(hasVideo ? ['-map', '[outv]'] : []),
    '-map', '[outa]',
    ...(hasVideo ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p'] : []),
    '-c:a', 'aac',
    '-b:a', '192k',
    output,
  ];

  return { filterScript: lines.join('\n').replace(/;$/, ''), args, segments: edl.keep.length };
}

/** ffmpeg wants plain decimals, never exponential notation. */
function f(seconds: number): string {
  return seconds.toFixed(4);
}
