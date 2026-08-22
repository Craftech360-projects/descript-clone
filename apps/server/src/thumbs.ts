import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG } from './config.ts';
import type { MediaInfo } from './ffmpeg.ts';

/**
 * The filmstrip: a ruler for picture.
 *
 * A timeline that shows only a waveform tells you where the sound is. A
 * filmstrip tells you where you ARE — it is the single element that makes a
 * timeline read as a video editor's rather than an audio tool's.
 *
 * Sheets, not files. 443 separate JPEGs would be 443 requests and 443 decodes;
 * one `tile=10x10` pass produces 5 sheets (measured: 562KB total, 8.3s) and the
 * canvas blits sub-rectangles straight out of them. 8.3s is also exactly why
 * this is a job and not part of import.
 *
 * Deliberately NOT deduped against near-identical frames: even spacing is the
 * whole point. A filmstrip whose tiles are unevenly spaced is not a ruler, it is
 * a contact sheet.
 */

export interface Thumbs {
  /** Seconds between frames. Tile index for time t is floor(t / interval). */
  interval: number;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  /** Real tiles. The last sheet is black-padded past this. */
  count: number;
  /** Browser-reachable sheet URLs, in order. */
  sheets: string[];
}

const TILE_H = 64;
const COLS = 10;
const ROWS = 10;

/**
 * Aim for roughly this many tiles regardless of duration, so a 15-minute talk
 * and a three-hour stream both cost about the same disk and the same 5 sheets.
 */
const TARGET_TILES = 500;

export function thumbsDir(): string {
  return join(CONFIG.mediaDir, 'thumbs');
}

export function planThumbs(info: MediaInfo): { interval: number; tileW: number; count: number } | null {
  if (!info.hasVideo || !info.width || !info.height || info.duration <= 0) return null;

  const interval = Math.max(1, Math.ceil(info.duration / TARGET_TILES));
  const tileW = Math.round((TILE_H * info.width) / info.height);
  // The fps filter emits at t=0, interval, 2*interval… up to the duration.
  const count = Math.floor(info.duration / interval) + 1;
  return { interval, tileW, count };
}

export async function generate(
  input: string,
  projectId: string,
  info: MediaInfo,
  hooks: { onSpawn?: (child: ChildProcess) => void } = {},
): Promise<Thumbs | null> {
  const plan = planThumbs(info);
  if (!plan) return null;

  const dir = thumbsDir();
  await mkdir(dir, { recursive: true });

  // Clear any previous run's sheets, or a shorter re-import would leave stale
  // high-numbered sheets behind and the strip would read frames that no longer
  // exist.
  for (const name of await readdir(dir).catch(() => [])) {
    if (name.startsWith(`${projectId}-`)) await rm(join(dir, name), { force: true });
  }

  const pattern = join(dir, `${projectId}-%03d.jpg`);
  const args = [
    '-hide_banner',
    '-v', 'error',
    '-i', input,
    // Explicit scale rather than -1: the tile filter needs every input the same
    // size, and we must know tileW exactly to index into the sheet later.
    //
    // But a bare `scale=W:H` with both dimensions given DISTORTS — it never
    // letterboxes. tileW is derived from the project record, so any disagreement
    // between that record and the real pixels came out as an anamorphic squeeze
    // rather than anything anyone could spot as a bug: a portrait frame in a
    // landscape tile just made everyone short and fat. `decrease` + `pad` keeps
    // the tile exactly tileW x TILE_H — which the sheet indexing depends on —
    // while degrading a mismatch to black bars instead of a stretch.
    '-vf',
    `fps=1/${plan.interval},` +
      `scale=${plan.tileW}:${TILE_H}:force_original_aspect_ratio=decrease,` +
      `pad=${plan.tileW}:${TILE_H}:(ow-iw)/2:(oh-ih)/2,` +
      `tile=${COLS}x${ROWS}`,
    '-an',
    '-q:v', '6',
    '-y',
    pattern,
  ];

  await new Promise<void>((resolve, reject) => {
    // CONFIG.ffmpegPath + windowsHide, matching ffmpeg.ts: a bare name off PATH
    // in dev/Docker, the shipped binary in the desktop build. checkTools() still
    // reports its absence before any traffic arrives.
    const child = spawn(CONFIG.ffmpegPath, args, { windowsHide: true });
    hooks.onSpawn?.(child);

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => reject(new Error(`Could not run ffmpeg: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(stderr.trim() || `ffmpeg exited ${code} building thumbnails`));
    });
  });

  const sheets = (await readdir(dir))
    .filter((n) => n.startsWith(`${projectId}-`) && n.endsWith('.jpg'))
    // Zero-padded %03d, so lexical order IS numeric order — but only up to 999
    // sheets, which at 100 tiles each is far past anything TARGET_TILES allows.
    .sort()
    .map((n) => `/media/thumbs/${n}`);

  if (sheets.length === 0) return null;

  return {
    interval: plan.interval,
    cols: COLS,
    rows: ROWS,
    tileW: plan.tileW,
    tileH: TILE_H,
    count: plan.count,
    sheets,
  };
}
