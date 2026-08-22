import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readdir, rm, writeFile, unlink } from 'node:fs/promises';
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

/**
 * The widest a tile may be drawn.
 *
 * Sizing purely by HEIGHT is right for landscape and wrong for vertical, which
 * is now the default shape here: a 9:16 frame at TILE_H=64 comes out 36px wide
 * and draws at about 30, which is legible as a ruler and useless as a picture.
 * Capping the WIDTH instead lets a portrait tile grow taller than 64 until it is
 * wide enough to recognise a shot in.
 *
 * 96 rather than something larger because the strip has to stay a strip: at one
 * tile every couple of seconds a 15-minute programme is hundreds of them, and
 * the sheets are downloaded before anything can be drawn.
 */
const MAX_TILE_W = 96;
/** Ceiling on the height a portrait tile may claim, so sheets stay reasonable. */
const MAX_TILE_H = 128;

export function planThumbs(
  info: MediaInfo,
): { interval: number; tileW: number; tileH: number; count: number } | null {
  if (!info.hasVideo || !info.width || !info.height || info.duration <= 0) return null;

  const interval = Math.max(1, Math.ceil(info.duration / TARGET_TILES));

  // Start from the height, as before — that is correct wherever the picture is
  // wider than it is tall.
  let tileH = TILE_H;
  let tileW = Math.round((TILE_H * info.width) / info.height);

  // Portrait: grow the tile until it is wide enough to read, within both caps.
  if (info.width < info.height) {
    const wanted = Math.min(MAX_TILE_W, Math.round(MAX_TILE_H * (info.width / info.height)));
    const scale = wanted / Math.max(1, tileW);
    tileW = wanted;
    tileH = Math.min(MAX_TILE_H, Math.round(TILE_H * scale));
  }

  // Both dimensions must be even: the tile filter builds a sheet that is then
  // JPEG-encoded with chroma subsampled 2:1, and an odd side gets rounded
  // somewhere unpredictable.
  tileW = Math.max(2, tileW - (tileW % 2));
  tileH = Math.max(2, tileH - (tileH % 2));

  // The fps filter emits at t=0, interval, 2*interval… up to the duration.
  const count = Math.floor(info.duration / interval) + 1;
  return { interval, tileW, tileH, count };
}

/** One clip's window into its file, for a strip that spans the whole timeline. */
export interface ThumbSource {
  sourcePath: string;
  /** Where in the file this clip starts. Absent means the whole file. */
  sourceStart?: number;
  /** The clip's own length — out minus in. */
  duration: number;
}

export async function generate(
  input: string | ThumbSource[],
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

  /**
   * Feed ffmpeg the WHOLE timeline, not just the first clip.
   *
   * The route used to pass clip 0's path together with the project's TOTAL
   * duration, so planThumbs sized a strip for the whole programme while ffmpeg
   * read one file — and every tile past the end of clip 0 came out black. A
   * two-clip project's strip simply stopped halfway.
   *
   * The concat demuxer's inpoint/outpoint are what make this exact: a split clip
   * is a WINDOW into a file its siblings also use, so listing paths alone would
   * replay whole files and desynchronise the strip from the timeline it labels.
   */
  let inputArgs: string[];
  let listPath: string | null = null;

  if (typeof input === 'string') {
    inputArgs = ['-i', input];
  } else {
    listPath = join(dir, `${projectId}-clips.txt`);
    const lines = ['ffconcat version 1.0'];
    for (const clip of input) {
      const start = clip.sourceStart ?? 0;
      lines.push(`file '${clip.sourcePath.replace(/'/g, "'\\''")}'`);
      lines.push(`inpoint ${start.toFixed(6)}`);
      lines.push(`outpoint ${(start + clip.duration).toFixed(6)}`);
    }
    await writeFile(listPath, lines.join('\n'), 'utf8');
    inputArgs = ['-f', 'concat', '-safe', '0', '-i', listPath];
  }

  const pattern = join(dir, `${projectId}-%03d.jpg`);
  const args = [
    '-hide_banner',
    '-v', 'error',
    ...inputArgs,
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
      `scale=${plan.tileW}:${plan.tileH}:force_original_aspect_ratio=decrease,` +
      `pad=${plan.tileW}:${plan.tileH}:(ow-iw)/2:(oh-ih)/2,` +
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

  // The concat list was scaffolding; the sheets are the product.
  if (listPath) await unlink(listPath).catch(() => {});

  return {
    interval: plan.interval,
    cols: COLS,
    rows: ROWS,
    tileW: plan.tileW,
    tileH: plan.tileH,
    count: plan.count,
    sheets,
  };
}
