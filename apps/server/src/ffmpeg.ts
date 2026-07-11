import { spawn } from 'node:child_process';
import { writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Edl } from '../../../packages/core/src/types.ts';
import { buildRenderPlan } from '../../../packages/core/src/render.ts';

export interface MediaInfo {
  duration: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width?: number;
  height?: number;
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
  };
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

/** Render an EDL to a finished file. This is the only place media is written. */
export async function renderEdl(
  edl: Edl,
  input: string,
  output: string,
  hasVideo: boolean,
): Promise<{ output: string; segments: number }> {
  const plan = buildRenderPlan(edl, { input, output, hasVideo });

  const scriptPath = join(tmpdir(), `edl-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  await writeFile(scriptPath, plan.filterScript, 'utf8');

  try {
    const args = plan.args.map((a) => (a === '{SCRIPT}' ? scriptPath : a));
    await run('ffmpeg', args);
    return { output, segments: plan.segments };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
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
