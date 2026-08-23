/**
 * Proxy media: a small stand-in to EDIT against, while the original is what ships.
 *
 * This is the oldest trick in video editing and every serious editor does it.
 * The problem it solves here is specific and measured: a 5-minute clip off a
 * modern phone is 1440x1920 HEVC at 10 Mbps — 368 MB — and scrubbing that over a
 * network to a phone browser is miserable. Worse, it is HEVC, which browsers
 * support unevenly; the picture can simply refuse to play.
 *
 * The proxy is 540x720 H.264 at 1.5 Mbps: 57 MB for the same five minutes, six
 * and a half times smaller, in a codec every browser decodes. Editing is
 * scrubbing, and scrubbing is what this makes fast.
 *
 * NOTHING about the export changes. The renderer reads `sourcePath` exactly as
 * before, so the finished video is cut from the original at full quality. The
 * proxy is a view, never a master — that distinction is the whole safety of the
 * idea, and the reason this file never touches the render path.
 *
 * Worth knowing when judging whether the proxy loses anything: every export
 * preset in this codebase lands at 1080x1920, and new projects default to a
 * reel. The delivered pixels are already far below the source.
 */

import { access, stat, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFile } from 'node:child_process';
import { dirname, join, basename, extname } from 'node:path';
import { promisify } from 'node:util';

import { CONFIG } from './config.ts';

const run = promisify(execFile);

/**
 * Height of the proxy, in pixels. 720 is the smallest that still lets you judge
 * focus and read a face — below that you stop being able to make editorial
 * decisions, which defeats the point of editing against it at all.
 */
const PROXY_HEIGHT = 720;
/** Enough for 720p motion without spending bandwidth on detail nobody will grade. */
const PROXY_BITRATE = '1500k';

const TIMEOUT_MS = 60 * 60 * 1000;

/** Where a source's proxy lives — beside it, so removing a project takes it too. */
export function proxyPathFor(sourcePath: string): string {
  return join(dirname(sourcePath), `${basename(sourcePath, extname(sourcePath))}-proxy.mp4`);
}

/**
 * The URL the browser plays, given the source's own media URL.
 *
 * Operates on the LAST PATH SEGMENT, not the whole string. Searching the whole
 * URL for a dot means a directory like `/media/my.v2/` swallows the match when
 * the file itself has no extension, and the result names a file that is never
 * written — which shows up not as an error but as a player silently falling back
 * to the full-size original forever.
 */
export function proxyUrlFor(sourceUrl: string): string {
  const cut = sourceUrl.lastIndexOf('/') + 1;
  const dir = sourceUrl.slice(0, cut);
  const file = sourceUrl.slice(cut);
  const dot = file.lastIndexOf('.');
  return `${dir}${dot === -1 ? file : file.slice(0, dot)}-proxy.mp4`;
}

/** Whether a usable proxy already exists and is newer than what it stands in for. */
export async function isFresh(sourcePath: string): Promise<boolean> {
  try {
    const [src, prox] = await Promise.all([stat(sourcePath), stat(proxyPathFor(sourcePath))]);
    return prox.size > 0 && prox.mtimeMs >= src.mtimeMs;
  } catch {
    return false;
  }
}

/**
 * Build the proxy for one source file. Returns its path.
 *
 * Hardware encoding where the machine has it — on this Mac a five-minute clip
 * took 43 seconds, which is the difference between "generated on import" and
 * "generated overnight". libx264 is the fallback rather than the default: it is
 * several times slower and the quality difference is invisible at 720p on a
 * proxy nobody will ever publish.
 *
 * `-vf scale=-2:H` keeps the aspect and forces an EVEN width, which H.264
 * requires — a 1440x1920 source scaled to 720 tall is 540 wide, but an odd
 * number there fails the encode outright rather than rounding.
 */
export async function build(
  sourcePath: string,
  onProgress?: (stage: string) => void,
): Promise<string> {
  const out = proxyPathFor(sourcePath);
  if (await isFresh(sourcePath)) return out;

  onProgress?.('Preparing preview');
  const common = [
    '-v', 'error',
    '-i', sourcePath,
    // Scaling DOWN only: a source already smaller than the proxy height would
    // otherwise be upscaled into a file bigger than the thing it stands in for.
    '-vf', `scale=-2:'min(${PROXY_HEIGHT},ih)'`,
    '-c:a', 'aac', '-b:a', '96k',
    // faststart puts the index at the front, so the browser can begin playing
    // before the whole file arrives — which is the entire point on a phone.
    '-movflags', '+faststart',
  ];

  try {
    await run(
      CONFIG.ffmpegPath,
      [...common, '-c:v', 'h264_videotoolbox', '-b:v', PROXY_BITRATE, out, '-y'],
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 24 },
    );
    return out;
  } catch {
    // No VideoToolbox (Linux, Docker, a Mac that refused the session): fall back
    // to software. Slower, same result.
    onProgress?.('Preparing preview (software)');
    await run(
      CONFIG.ffmpegPath,
      [...common, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', out, '-y'],
      { timeout: TIMEOUT_MS, maxBuffer: 1 << 24 },
    );
    return out;
  }
}

/** Remove a proxy — when its source is deleted, or to force a rebuild. */
export async function discard(sourcePath: string): Promise<void> {
  await unlink(proxyPathFor(sourcePath)).catch(() => {});
}

/** Whether ffmpeg is even present. The proxy is an optimisation, never a requirement. */
export async function possible(): Promise<boolean> {
  try {
    await access(CONFIG.ffmpegPath, constants.X_OK);
    return true;
  } catch {
    // A bare name resolved off PATH cannot be access()ed; assume yes and let the
    // spawn fail loudly if it is wrong.
    return !CONFIG.ffmpegPath.includes('/');
  }
}
