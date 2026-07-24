import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CONFIG } from './config.ts';
import type { Edl } from '../../../packages/core/src/types.ts';
import {
  buildRenderPlan,
  buildSequenceRenderPlan,
  type BgMusicRender,
  type SequenceRenderClip,
} from '../../../packages/core/src/render.ts';
import type { Grade } from '../../../packages/core/src/color.ts';
import type { FrameRender } from '../../../packages/core/src/frame.ts';
import type { OutputMove } from '../../../packages/core/src/frame-track.ts';
import { outputDuration } from '../../../packages/core/src/edl.ts';

export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
  /** Frames per second, e.g. 59.94. Absent for audio, or if ffprobe won't say. */
  fps?: number;
}

/**
 * Report whether ffmpeg and ffprobe can actually be spawned.
 *
 * Their absence is not a startup error — the process boots fine and then fails
 * on the first import with a spawn ENOENT, which reads as an app bug rather
 * than a missing dependency. A health check says so before any traffic arrives.
 */
export async function checkTools(): Promise<{ ffmpeg: string | null; ffprobe: string | null }> {
  const version = async (bin: string): Promise<string | null> => {
    try {
      const out = await run(bin, ['-version']);
      return out.split('\n')[0]?.trim() ?? null;
    } catch {
      return null;
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([
    version(CONFIG.ffmpegPath),
    version(CONFIG.ffprobePath),
  ]);
  return { ffmpeg, ffprobe };
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await run(CONFIG.ffprobePath, [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    path,
  ]);

  const data = JSON.parse(out);
  const video = data.streams?.find((s: any) => s.codec_type === 'video');
  const audio = data.streams?.find((s: any) => s.codec_type === 'audio');

  if (!audio) {
    throw new Error('This file has no audio track, so there is nothing to transcribe.');
  }

  return {
    duration: Number(data.format?.duration ?? 0),
    hasVideo: Boolean(video),
    hasAudio: true,
    width: video?.width,
    height: video?.height,
    // avg_frame_rate FIRST, and the order is the whole ballgame. The render's
    // video cut renumbers kept frames to a constant rate with setpts=N/fps, so
    // fps must be frames÷duration — the AVERAGE rate — to reproduce real time.
    // r_frame_rate is the timebase base rate: equal to the average on constant-
    // frame-rate media, but far higher on a variable-frame-rate source (screen
    // grabs, phone video, browser/OBS captures — exactly what gets imported).
    // Feed r_frame_rate into setpts=N/fps there and the frames pack too tightly,
    // so the export runs FASTER than real time and ahead of the audio. Fall back
    // to r_frame_rate only when avg is unusable ("0/0").
    fps: parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate),
  };
}

/**
 * ffprobe reports frame rate as a STRING RATIONAL — "60000/1001", not 59.94.
 *
 * It was already in the -show_streams response we parse; nothing read it. Two
 * traps: audio streams report "0/0", which divides to NaN, and a variable-rate
 * stream can report "0/0" on avg_frame_rate too — which is why the caller keeps
 * r_frame_rate as a fallback.
 */
function parseFps(rational: unknown): number | undefined {
  if (typeof rational !== 'string') return undefined;
  const [num, den] = rational.split('/').map(Number);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0 || num === 0) return undefined;
  return num / den;
}

/**
 * Extract a mono 16 kHz WAV for ASR. Every speech model wants this, and sending
 * a 200 MB video to a transcription API instead of a 5 MB wav is slow and, on a
 * paid API, wasteful.
 */
export async function extractAudioForAsr(input: string, output: string): Promise<string> {
  await run(CONFIG.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'pcm_s16le',
    output,
  ]);
  return output;
}

/**
 * Render an EDL to a finished file. This is the only place media is written.
 *
 * Pass `subtitles` (ASS markup) to burn captions into the picture. Burned
 * captions are pixels: they cannot be turned off downstream, which is the point
 * for social video, and the reason it stays opt-in.
 */
export interface RenderHooks {
  /** Called with 0..1 as encoding proceeds. Determinate: we know the target. */
  onProgress?: (fraction: number) => void;
  /** Hand the child process to the caller so a cancel can kill it. */
  onSpawn?: (child: ChildProcess) => void;
}

/** What to render, as one object: this was six positional arguments. */
export interface RenderJob {
  input: string;
  output: string;
  /** Audio-only sources skip the video chain entirely. */
  hasVideo: boolean;
  /** ASS markup to burn into the picture. Omit to render clean. */
  subtitles?: string;
  /**
   * Directory of imported font files to hand libass, so a burned caption can use
   * an imported family. Inert without `subtitles`. See fonts.ts / render.ts.
   */
  fontsDir?: string;
  /** Output speed multiplier. Must already be clamped — see clampSpeed. */
  speed?: number;
  /**
   * Source frame rate. The video cut re-numbers kept frames against it, so a
   * wrong or missing value is a broken output rather than a slow one — when the
   * project record has none, renderEdl probes for it rather than guessing.
   */
  fps?: number;
  /**
   * The source files for a multi-clip stitch, in the SAME order as edl.clips.
   * Present (and matching edl.clips length) makes renderEdl concatenate these
   * into one output instead of cutting the single `input`. Any clip missing its
   * fps is probed. `input` is still required and names the first clip.
   */
  clips?: SequenceRenderClip[];
  /** Canonical output frame size for a multi-clip stitch — the first video clip's. */
  width?: number;
  height?: number;
  /**
   * A background-music bed mixed under the finished program. Omit for none. Works
   * on both the single-input and the multi-clip path, and on audio-only projects.
   * Its `durationSec` is already resolved to the output clock by the caller.
   */
  bgMusic?: BgMusicRender;
  /**
   * Run the program audio through the Studio Sound voice chain before the music
   * bed is mixed in — so the enhancer works on the voice alone and never touches
   * the bed. See studioSoundStages in render.ts.
   */
  studioSound?: boolean;
  /**
   * The crop into a target resolution, already resolved to concrete pixels by the
   * caller — resolveFrame returns null when the setting would change nothing, and
   * that null is why an unreframed project emits no scale/crop at all.
   *
   * This field was missing while index.ts was already passing it, so the value
   * was dropped on the floor here and every export came out at the source's
   * shape however the Frame panel was set. Nothing caught it: the plan builders
   * treat an absent frame as "no reframe", which is a legitimate render.
   */
  frame?: FrameRender;
  /**
   * The colour grade, already resolved to a matrix and an affine by the caller —
   * resolveColor returns null when the grade is neutral. Omit to leave the
   * picture's values untouched. See colorFilterStages in render.ts.
   */
  color?: Grade;
  /**
   * Animated push-ins over the finished frame, already mapped onto the OUTPUT
   * clock by the caller (movesToOutput) and carrying the delivered frame's size.
   *
   * The frame RATE is deliberately not here. zoompan generates its own
   * timestamps from it, so a stale one is a video of the wrong length — and the
   * correct value is the one this function probes for the frame renumber, or the
   * canonical rate it picks for a stitch. Both are resolved below, so the punch
   * takes whichever applies rather than making the caller guess which path it is
   * on. This is the same class of bug the `frame` field's comment records.
   */
  punch?: { moves: OutputMove[]; width: number; height: number };
}

export async function renderEdl(
  edl: Edl,
  job: RenderJob,
  hooks: RenderHooks = {},
): Promise<{ output: string; segments: number; burnedIn: boolean }> {
  const { input, output, hasVideo, subtitles, speed = 1, fontsDir, bgMusic, studioSound, frame, color } =
    job;
  // A multi-clip stitch when the caller handed us one file per EDL clip. A single
  // clip falls through to the original single-input path, byte-identical.
  const sequence = Boolean(edl.clips && edl.clips.length > 1 && job.clips && job.clips.length === edl.clips.length);
  // fps drives the video cut's frame renumbering (setpts=N/fps), so a wrong value
  // is a wrong-speed picture, not a slow render. Probe fresh rather than trust the
  // stored project.fps: a project imported before the avg_frame_rate fix holds
  // r_frame_rate, which is wrong for variable-frame-rate media and would keep
  // exporting too fast. One probe costs milliseconds; getting this wrong costs the
  // whole encode. An explicit job.fps still wins, for a caller that already probed.
  const fps = hasVideo && !sequence ? (job.fps ?? (await probe(input)).fps) : undefined;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const scriptPath = join(tmpdir(), `edl-${stamp}.txt`);
  // libass picks the parser from the extension, so this must stay .ass.
  const subtitlePath = subtitles ? join(tmpdir(), `cap-${stamp}.ass`) : undefined;

  if (subtitlePath) {
    // No BOM: ffmpeg reads a leading U+FEFF as part of the first token and the
    // filtergraph fails to parse with "trailing garbage".
    await writeFile(subtitlePath, subtitles!, 'utf8');
  }

  // Encode to a partial file and rename only on success. Two things this fixes:
  // a canceled or crashed render used to leave a truncated file sitting in
  // media/renders/ looking exactly like a finished one, and on Windows a killed
  // ffmpeg cannot finalise its container at all.
  //
  // The marker goes BEFORE the extension, never after: ffmpeg picks the output
  // muxer from the extension, so "video.mp4.part" fails outright with "Unable to
  // choose an output format". "video.part.mp4" still reads as mp4.
  const partial = output.replace(/(\.[^.]+)$/, '.part$1');
  // fontsDir only matters when there is a subtitle to burn; both plan builders
  // ignore it otherwise, so passing it unconditionally is harmless.
  let plan;
  if (sequence) {
    // Resolve every clip's own fps (the frame renumber needs it), then pick the
    // canonical output rate as the fastest clip so no clip has frames dropped to
    // hit it. Size is the first video clip's, letterboxing the rest.
    const clips = await Promise.all(
      job.clips!.map(async (c) => ({
        input: c.input,
        fps: hasVideo ? (c.fps ?? (await probe(c.input)).fps) : undefined,
        sourceStart: c.sourceStart,
      })),
    );
    const canonFps = Math.max(0, ...clips.map((c) => c.fps ?? 0)) || 30;
    plan = buildSequenceRenderPlan(edl, {
      clips,
      output: partial,
      hasVideo,
      width: job.width ?? 1920,
      height: job.height ?? 1080,
      fps: canonFps,
      subtitlePath,
      speed,
      fontsDir: subtitlePath ? fontsDir : undefined,
      bgMusic,
      studioSound,
      frame,
      color,
      // The canonical rate every clip was resampled to — not any one clip's, or
      // zoompan would re-time the join to a rate the join does not have.
      punch: job.punch ? { ...job.punch, fps: canonFps } : undefined,
    });
  } else {
    plan = buildRenderPlan(edl, {
      input,
      output: partial,
      hasVideo,
      subtitlePath,
      speed,
      fps,
      fontsDir: subtitlePath ? fontsDir : undefined,
      bgMusic,
      studioSound,
      frame,
      color,
      // The same freshly-probed rate the frame renumber uses. Undefined when the
      // probe could not say, and punchFilterStage then emits nothing rather than
      // guessing — losing the move is recoverable, a mistimed export is not.
      punch: job.punch && fps ? { ...job.punch, fps } : undefined,
    });
  }
  await writeFile(scriptPath, plan.filterScript, 'utf8');

  // The output length is known exactly, so this progress is real, not a guess.
  //
  // Speed divides it, and must: ffmpeg reports out_time against the OUTPUT, which
  // at 1.2x reaches the end after 1/1.2 of the un-sped length. Measuring against
  // the wrong target does not just skew the bar — it pins at 83% and never
  // finishes, which reads as a hung render.
  const target = outputDuration(edl, speed);

  try {
    const args = plan.args.map((a) => (a === '{SCRIPT}' ? scriptPath : a));
    await runWithProgress(CONFIG.ffmpegPath, args, target, hooks);
    await rename(partial, output);
    return { output, segments: plan.segments, burnedIn: Boolean(subtitlePath && hasVideo) };
  } catch (e) {
    await unlink(partial).catch(() => {});
    throw e;
  } finally {
    await unlink(scriptPath).catch(() => {});
    if (subtitlePath) await unlink(subtitlePath).catch(() => {});
  }
}

/**
 * Run ffmpeg with `-progress pipe:1`, reporting a real fraction.
 *
 * ffmpeg emits `key=value` lines to stdout. The trap: `out_time_ms` is
 * MICROseconds despite its name — a long-standing misnomer. Divide it by 1000
 * and progress reads 1000x too high and pins at 100% immediately. We read
 * `out_time_us` when present and fall back to `out_time_ms`, treating both as
 * microseconds.
 */
function runWithProgress(
  bin: string,
  args: string[],
  targetSeconds: number,
  hooks: RenderHooks,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-progress', 'pipe:1', '-nostats', ...args], { windowsHide: true });
    hooks.onSpawn?.(proc);

    let stderr = '';
    let carry = '';

    proc.stdout.on('data', (d: Buffer) => {
      carry += d.toString();
      const lines = carry.split('\n');
      carry = lines.pop() ?? ''; // keep the partial line for the next chunk

      for (const line of lines) {
        const [key, value] = line.split('=');
        if (key !== 'out_time_us' && key !== 'out_time_ms') continue;
        const micros = Number(value);
        if (!Number.isFinite(micros) || targetSeconds <= 0) continue;
        const fraction = Math.min(1, micros / 1e6 / targetSeconds);
        hooks.onProgress?.(fraction);
      }
    });

    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) =>
      reject(new Error(`Could not run ${bin}. Is it on PATH? (${err.message})`)),
    );
    proc.on('close', (code, signal) => {
      if (code === 0) return resolve();
      if (signal || code === null) return reject(new Error('Render canceled.'));
      reject(new Error(`${bin} exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}

/**
 * Waveform peaks for the timeline. Decodes to raw mono PCM and reduces it to
 * `buckets` amplitude values in [0,1].
 *
 * The timeline is worth having real data behind: a fake waveform is worse than
 * none, because you cannot use it to find the edit point you are looking for.
 */
export async function computePeaks(input: string, buckets = 1600): Promise<number[]> {
  const pcm = await runBinary(CONFIG.ffmpegPath, [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-vn',
    '-ac', '1',
    '-ar', '8000',        // plenty for a visual envelope; keeps the buffer small
    '-f', 's16le',
    '-',
  ]);

  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.length / 2));
  if (samples.length === 0) return [];

  const size = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];

  for (let i = 0; i < samples.length; i += size) {
    let max = 0;
    const end = Math.min(i + size, samples.length);
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(max / 32768);
  }

  return peaks;
}

function runBinary(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    const chunks: Buffer[] = [];
    let stderr = '';

    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d) => (stderr += d));
    proc.on('error', (err) => reject(new Error(`Could not run ${bin}: ${err.message}`)));
    proc.on('close', (code) =>
      code === 0
        ? resolve(Buffer.concat(chunks))
        : reject(new Error(`${bin} exited ${code}: ${stderr.trim()}`)),
    );
  });
}

function run(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d));
    proc.stderr.on('data', (d) => (stderr += d));

    proc.on('error', (err) =>
      reject(new Error(`Could not run ${bin}. Is it on PATH? (${err.message})`)),
    );

    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim() || '(no stderr)'}`));
    });
  });
}
