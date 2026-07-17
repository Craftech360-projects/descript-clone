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
  const { input, output, hasVideo, subtitlePath } = options;
  const burnIn = Boolean(hasVideo && subtitlePath);

  if (edl.keep.length === 0) {
    throw new Error('Cannot render an empty EDL: every word was deleted.');
  }

  const lines: string[] = [];
  const concatInputs: string[] = [];

  edl.keep.forEach((range, i) => {
    const duration = range.end - range.start;
    // A segment shorter than two fades would fade in and immediately out,
    // audibly ducking a real word. Shrink the fade to fit.
    const fade = Math.min(edl.fadeMs / 1000, duration / 2);
    const fadeOutStart = Math.max(0, duration - fade);

    if (hasVideo) {
      lines.push(
        `[0:v]trim=start=${f(range.start)}:end=${f(range.end)},setpts=PTS-STARTPTS[v${i}];`,
      );
      concatInputs.push(`[v${i}]`);
    }

    lines.push(
      `[0:a]atrim=start=${f(range.start)}:end=${f(range.end)},asetpts=PTS-STARTPTS,` +
        `afade=t=in:st=0:d=${f(fade)},afade=t=out:st=${f(fadeOutStart)}:d=${f(fade)}[a${i}];`,
    );
    concatInputs.push(`[a${i}]`);
  });

  const n = edl.keep.length;
  const v = hasVideo ? 1 : 0;
  // concat wants inputs interleaved per segment: [v0][a0][v1][a1]...
  const ordered = hasVideo
    ? edl.keep.map((_, i) => `[v${i}][a${i}]`).join('')
    : concatInputs.join('');

  // Burn-in happens AFTER the concat, never before. The cues are timed against
  // the OUTPUT timeline (see toCues), so they only line up once the kept ranges
  // are spliced together. Burning onto the source first would drift every
  // caption by exactly the amount cut before it.
  const videoLabel = burnIn ? '[vcat]' : '[outv]';

  lines.push(
    `${ordered}concat=n=${n}:v=${v}:a=1${hasVideo ? videoLabel : ''}[outa]${burnIn ? ';' : ''}`,
  );

  if (burnIn) {
    lines.push(`[vcat]subtitles=filename='${escapeSubtitlePath(subtitlePath!)}'[outv]`);
  }

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

  return { filterScript: lines.join('\n'), args, segments: n };
}

/** ffmpeg wants plain decimals, never exponential notation. */
function f(seconds: number): string {
  return seconds.toFixed(4);
}
