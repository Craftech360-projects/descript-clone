/**
 * Burn captions WITHOUT libass, by rasterising them with CoreText.
 *
 * ── why ─────────────────────────────────────────────────────────────────────
 *
 * The normal route is ffmpeg's `subtitles` filter, which is libass. That filter
 * is a BUILD OPTION and Homebrew's ffmpeg formula does not carry it — the
 * declared dependencies are dav1d, lame, libvmaf, libvpx, openssl, opus,
 * sdl2-compat, svt-av1, x264, x265 and xz, with no libass, freetype or
 * fontconfig. `subtitles`, `ass` and `drawtext` are all absent, so every export
 * with captions enabled failed on "No such filter: 'subtitles'", and no amount
 * of reinstalling brings it back: it was never in the bottle.
 *
 * CoreText is on every Mac and is the better text engine anyway. So the glyphs
 * are drawn by a small Swift helper and ffmpeg is left compositing images, which
 * it can always do.
 *
 * ── the shape of the thing ──────────────────────────────────────────────────
 *
 * A caption changes only when its WORDS change: at a cue boundary, or on the
 * next word while karaoke is running. So the track is cut into STATES rather
 * than frames — a few hundred tiles for a programme, instead of one per frame —
 * and the concat demuxer plays them back with a `duration` against each. ffmpeg
 * then needs exactly one `overlay`, however many captions there are, which
 * matters because the filtergraph already grows with the cut count.
 *
 * Every tile is the caption BOX, not the whole frame, so the tiles are small and
 * the overlay has a single fixed position.
 */

import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Cue } from '../../../packages/core/src/captions.ts';
import {
  captionScale,
  type CaptionSettings,
} from '../../../packages/core/src/caption-style.ts';
import { layoutCaption } from '../../../packages/core/src/caption-layout.ts';
import { platformSupported } from './apple-speech.ts';

const here = dirname(fileURLToPath(import.meta.url));
const NATIVE_DIR = join(here, '..', 'native', 'caption-render');
const SOURCE = join(NATIVE_DIR, 'main.swift');
const BINARY = join(NATIVE_DIR, 'jumpcut-captions');

/** One tile: what is on screen, and for how long. */
interface Segment {
  duration: number;
  lines: string[];
  /** Index of the last SPOKEN word across the whole tile; -1 for no karaoke. */
  highlight: number;
}

export interface CaptionStrip {
  /** The concat list ffmpeg reads as an image stream. */
  listPath: string;
  /** Where the box sits in the output frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Temp directory holding the tiles, for the caller to clean up. */
  dir: string;
  tiles: number;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Build the helper if it is missing or older than its source. Same rule as the ASR one. */
async function ensureBinary(): Promise<string> {
  if (await exists(BINARY)) return BINARY;
  await new Promise<void>((resolve, reject) => {
    const child = spawn('swiftc', ['-O', SOURCE, '-o', BINARY], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => { err += String(c); });
    child.on('error', (e) => reject(new Error(`swiftc could not be started: ${e.message}`)));
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`swiftc failed: ${err.slice(0, 500)}`))));
  });
  return BINARY;
}

/**
 * Cached answer, so request handlers that cannot await still know. Same pattern
 * and same reason as the on-device speech probe.
 */
let ready = false;

export function captionImagesReady(): boolean {
  return ready;
}

/** Can this machine draw captions without libass? Probed once, at startup. */
export async function available(): Promise<boolean> {
  if (!platformSupported()) return false;
  if (await exists(BINARY)) return true;
  try {
    await access(SOURCE, constants.F_OK);
  } catch {
    return false;
  }
  return true;
}

export async function probeAvailability(): Promise<boolean> {
  ready = await available();
  return ready;
}

/**
 * Cut the cue list into tile states.
 *
 * Gaps between cues become transparent tiles rather than being skipped, because
 * the concat stream has to be continuous — a hole in it would hold the previous
 * caption on screen instead of clearing it.
 */
function segmentsFor(cues: Cue[], settings: CaptionSettings, frame: { width: number; height: number }): Segment[] {
  const out: Segment[] = [];
  let clock = 0;

  for (const cue of cues) {
    if (cue.start > clock + 0.001) {
      out.push({ duration: cue.start - clock, lines: [], highlight: -1 });
    }

    const laid = layoutCaption(
      cue.words.map((w) => w.text),
      settings,
      frame,
    );
    const lines = laid.length > 0 ? laid.map((l) => l.text) : [cue.text];

    if (!settings.karaoke || cue.words.length === 0) {
      out.push({ duration: Math.max(0.001, cue.end - cue.start), lines, highlight: cue.words.length - 1 });
    } else {
      // One tile per word, so the highlight advances with the voice. The word's
      // own [start,end] is on the OUTPUT clock already — toCues put it there.
      cue.words.forEach((w, i) => {
        const start = Math.max(cue.start, w.start);
        const end = i === cue.words.length - 1 ? cue.end : Math.max(start, cue.words[i + 1].start);
        const duration = end - start;
        if (duration <= 0.001) return;
        out.push({ duration, lines, highlight: i });
      });
    }
    clock = cue.end;
  }

  return out;
}

/**
 * Render the caption track to tiles and return what the render needs to composite
 * them. Returns null when there is nothing to draw.
 */
export async function build(
  cues: Cue[],
  settings: CaptionSettings,
  frame: { width: number; height: number },
  mediaDir: string,
  jobId: string,
): Promise<CaptionStrip | null> {
  if (cues.length === 0) return null;

  const segments = segmentsFor(cues, settings, frame);
  if (segments.length === 0) return null;

  const scale = captionScale(frame.height);
  // The box, in output pixels, centred on the anchor exactly as the preview
  // places it — both sides read the same fractions.
  const width = Math.max(2, Math.round(settings.boxWidth * frame.width));
  const height = Math.max(2, Math.round(settings.boxHeight * frame.height));
  const x = Math.round(settings.x * frame.width - width / 2);
  const y = Math.round(settings.y * frame.height - height / 2);

  const dir = join(mediaDir, 'tmp', `captions-${jobId}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  const manifest = {
    dir,
    boxWidth: width,
    boxHeight: height,
    fontName: settings.font,
    fontSize: settings.fontSize * scale,
    color: settings.color,
    highlightColor: settings.highlightColor,
    strokeColor: settings.strokeColor,
    strokeWidth: settings.strokeWidth * scale,
    backdrop: settings.backdrop,
    lineGap: 1.25,
    segments: segments.map((s) => ({
      duration: s.duration,
      lines: settings.allCaps ? s.lines.map((l) => l.toUpperCase()) : s.lines,
      highlight: s.highlight,
    })),
  };

  const binary = await ensureBinary();

  const list = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', (e) => reject(new Error(`caption renderer failed to start: ${e.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`caption renderer failed (${code}): ${stderr.slice(0, 400)}`));
    });
    child.stdin.end(JSON.stringify(manifest));
  });

  const listPath = join(dir, 'captions.txt');
  await writeFile(listPath, list, 'utf8');

  return { listPath, x, y, width, height, dir, tiles: segments.length + 1 };
}

/** Tiles are scratch. Losing the cleanup would fill the media directory quietly. */
export async function cleanup(strip: CaptionStrip | null): Promise<void> {
  if (!strip) return;
  await rm(strip.dir, { recursive: true, force: true }).catch(() => {});
}
