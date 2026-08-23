/**
 * Cleaning speech that was recorded outdoors.
 *
 * Studio Sound (see studioSoundStages in render.ts) is a chain of ffmpeg filters,
 * and filters can only subtract a noise estimate they can hold still. That works
 * for a room's hiss and hum. It does not work for traffic, a crowd, or wind,
 * because none of those hold still — measured on real footage, the whole Studio
 * Sound chain moved the noise floor by about 3 dB.
 *
 * DeepFilterNet is a trained model instead: it separates speech from everything
 * that is not speech, which is the actual problem. It is not an ffmpeg filter and
 * cannot join the chain, so it runs as its own pass, ONCE per source file, and
 * the result is cached beside the original.
 *
 * The cached file is a full drop-in replacement for the source: same video stream,
 * copied rather than re-encoded, with the cleaned audio in place of the original.
 * That is deliberate — it means the renderer, the EDL, captions, multi-clip stitch
 * and every other downstream path work on it unchanged, with no knowledge that any
 * of this happened.
 */

import { access, mkdir, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { join, dirname, basename, extname } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

import { CONFIG } from './config.ts';

const run = promisify(execFile);

/** Generous: the model is ~50x faster than realtime, but a long file still has to be decoded. */
const TIMEOUT_MS = 30 * 60 * 1000;

let probed: boolean | null = null;

/**
 * Whether the denoiser is usable. Probed once and remembered, like the Apple
 * speech helper — this is asked per request and must not spawn a process each time.
 */
export async function available(): Promise<boolean> {
  if (probed !== null) return probed;
  if (!CONFIG.deepFilterBin) return (probed = false);
  try {
    await access(CONFIG.deepFilterBin, constants.X_OK);
    probed = true;
  } catch {
    probed = false;
  }
  return probed;
}

/** Forget the probe — for tests, and for a settings change that installs the tool. */
export function reprobe(): void {
  probed = null;
}

/** Where the cleaned copy of a source lives. Beside it, so removing a project takes it too. */
export function cleanedPathFor(sourcePath: string): string {
  const ext = extname(sourcePath);
  return join(dirname(sourcePath), `${basename(sourcePath, ext)}-clean${ext || '.mp4'}`);
}

/**
 * Produce (or reuse) a cleaned copy of `sourcePath`, and return its path.
 *
 * Cached on the filesystem rather than in memory: denoising is the expensive step
 * and a render must not pay it twice. The cache is keyed by path and validated by
 * mtime, so re-importing over a source invalidates it rather than silently
 * serving the old audio.
 *
 * Throws when the tool is missing. The caller decides what that means — the
 * render route turns it into a message naming the fix, rather than quietly
 * exporting noisy audio the user believed was cleaned.
 */
export async function ensureCleaned(
  sourcePath: string,
  onProgress?: (stage: string) => void,
): Promise<string> {
  if (!(await available())) {
    throw new Error(
      'Voice cleanup is not installed on this server. It needs DeepFilterNet and the DEEPFILTER_BIN path set.',
    );
  }

  const out = cleanedPathFor(sourcePath);
  const src = await stat(sourcePath);
  try {
    const cached = await stat(out);
    // Newer than the source it came from = still valid. A source replaced in
    // place (re-import, rotation fix) is newer, and invalidates this.
    if (cached.mtimeMs >= src.mtimeMs && cached.size > 0) return out;
  } catch {
    /* no cache yet */
  }

  const work = join(tmpdir(), `dfn-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(work, { recursive: true });
  const wavIn = join(work, 'in.wav');

  try {
    // DeepFilterNet works at 48k. Mono because the model is a speech model and a
    // stereo field means nothing to it — and because a phone's second channel is
    // usually a copy of the first anyway.
    onProgress?.('Extracting audio');
    await run(CONFIG.ffmpegPath, ['-v', 'error', '-i', sourcePath, '-vn', '-ar', '48000', '-ac', '1', '-c:a', 'pcm_s16le', wavIn, '-y'], {
      timeout: TIMEOUT_MS,
      maxBuffer: 1 << 24,
    });

    onProgress?.('Cleaning voice');
    await run(CONFIG.deepFilterBin, [wavIn, '-o', work], { timeout: TIMEOUT_MS, maxBuffer: 1 << 24 });

    // The tool names its output after the input and the model it used, which is
    // a detail of the tool rather than a contract. Find it instead of assuming.
    const { readdir } = await import('node:fs/promises');
    const produced = (await readdir(work)).find((f) => f.endsWith('.wav') && f !== 'in.wav');
    if (!produced) throw new Error('the denoiser produced no output');

    onProgress?.('Rebuilding media');
    // -c:v copy is the point: the picture is not touched, so this costs seconds
    // rather than an encode, and loses nothing. Only the audio is replaced.
    // -shortest guards the case where the cleaned track is a frame longer.
    await run(
      CONFIG.ffmpegPath,
      ['-v', 'error', '-i', sourcePath, '-i', join(work, produced),
       '-map', '0:v?', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
       '-movflags', '+faststart', '-shortest', out, '-y'],
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 24 },
    );

    return out;
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
