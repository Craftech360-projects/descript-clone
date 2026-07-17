import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile, unlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Edl } from '../../../packages/core/src/types.ts';
import { buildRenderPlan } from '../../../packages/core/src/render.ts';
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
  const [ffmpeg, ffprobe] = await Promise.all([version('ffmpeg'), version('ffprobe')]);
  return { ffmpeg, ffprobe };
}

export async function probe(path: string): Promise<MediaInfo> {
  const out = await run('ffprobe', [
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
    fps: parseFps(video?.r_frame_rate) ?? parseFps(video?.avg_frame_rate),
  };
}

/**
 * ffprobe reports frame rate as a STRING RATIONAL — "60000/1001", not 59.94.
 *
 * It was already in the -show_streams response we parse; nothing read it. Two
 * traps: audio streams report "0/0", which divides to NaN, and a variable-rate
 * stream can report "0/0" on avg_frame_rate too.
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
  await run('ffmpeg', [
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

export async function renderEdl(
  edl: Edl,
  input: string,
  output: string,
  hasVideo: boolean,
  subtitles?: string,
  hooks: RenderHooks = {},
): Promise<{ output: string; segments: number; burnedIn: boolean }> {
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
  const plan = buildRenderPlan(edl, { input, output: partial, hasVideo, subtitlePath });
  await writeFile(scriptPath, plan.filterScript, 'utf8');

  // The output length is known exactly, so this progress is real, not a guess.
  const target = outputDuration(edl);

  try {
    const args = plan.args.map((a) => (a === '{SCRIPT}' ? scriptPath : a));
    await runWithProgress('ffmpeg', args, target, hooks);
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
  const pcm = await runBinary('ffmpeg', [
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
