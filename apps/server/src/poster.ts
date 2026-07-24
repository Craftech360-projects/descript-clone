import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.ts';

/**
 * One frame per project: the cover its card wears on the dashboard.
 *
 * Not the filmstrip sheets. Those are 64px tall — a ruler for the timeline, not
 * a picture — and upscaling a tile to card size is a smear. Not a <video> in the
 * grid either: that streams real media bytes into a screen that is only showing
 * you what you have, and browsers paint a `#t=` frame on their own schedule, so
 * a grid of them is a grid of black rectangles until they feel like decoding.
 *
 * A single `-ss` seek and one JPEG. Written once, then it is a static file the
 * /media handler serves like any other.
 */

/** Wide enough for a 2x card, small enough that eight of them are a few hundred KB. */
const WIDTH = 640;

export function posterDir(): string {
  return join(CONFIG.mediaDir, 'posters');
}

/**
 * Where to grab the frame from, in seconds.
 *
 * A tenth in, capped: the frame at 0 is a fade from black, a slate, or a title
 * card often enough that a grid of first frames reads as a grid of nothing. The
 * cap keeps a three-hour recording from opening on something eighteen minutes in
 * that has nothing to do with what it is.
 */
function coverTime(duration: number): number {
  return Math.min(10, Math.max(0, duration * 0.1));
}

/**
 * Build the cover for a project, unless it is already on disk.
 *
 * Returns the browser-reachable URL, or null when there is no picture to take
 * one from (audio) or ffmpeg could not. A missing cover is not an error — the
 * card falls back to its mark — so every failure path here is a null, never a
 * throw.
 */
export async function ensure(
  input: string,
  projectId: string,
  duration: number,
  hasVideo: boolean,
): Promise<string | null> {
  if (!hasVideo || !(duration > 0)) return null;

  const url = `/media/posters/${projectId}.jpg`;
  const file = join(posterDir(), `${projectId}.jpg`);
  // Already built. Size-checked because an ffmpeg killed mid-write leaves a
  // 0-byte file behind, and serving that is a broken image forever.
  const existing = await stat(file).catch(() => null);
  if (existing && existing.size > 0) return url;

  await mkdir(posterDir(), { recursive: true });

  // -ss BEFORE -i: the input-side seek jumps by keyframe index instead of
  // decoding from the top, which is the difference between 80ms and a minute on
  // a long file. Frame-exactness does not matter for a cover.
  const args = [
    '-hide_banner',
    '-v', 'error',
    '-ss', coverTime(duration).toFixed(3),
    '-i', input,
    '-frames:v', '1',
    // min(), so a 320-wide source is not blown up to 640 and made soft. -2 keeps
    // the aspect and lands on an even height, which the JPEG encoder wants.
    '-vf', `scale='min(${WIDTH},iw)':-2`,
    '-q:v', '4',
    '-y',
    file,
  ];

  const ok = await new Promise<boolean>((resolve) => {
    // CONFIG.ffmpegPath + windowsHide, matching ffmpeg.ts and thumbs.ts: a bare
    // name off PATH in dev, the shipped binary in the desktop build.
    const child = spawn(CONFIG.ffmpegPath, args, { windowsHide: true });
    child.stderr.resume(); // drain, or a chatty failure fills the pipe and hangs
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
  if (!ok) return null;

  const written = await stat(file).catch(() => null);
  return written && written.size > 0 ? url : null;
}
