import type { Edl } from './types.ts';

/**
 * The timeline's maths, kept pure so it can be tested without a canvas.
 *
 * The temptation with a timeline is to put all of this inside a React component
 * and eyeball it. Everything here is a pure function of numbers, which means it
 * gets the same treatment as compileEdl: tests, no media, no browser.
 */

/** Maps time to pixels. Both views (source, output) satisfy this interface. */
export interface TimeMap {
  /** Domain length in seconds — the source duration, or the output duration. */
  domain: number;
  /** Seconds per screen pixel is implied by pxPerSec; this is the left edge. */
  scrollSec: number;
  pxPerSec: number;
  toX(time: number): number;
  toTime(x: number): number;
}

export function sourceMap(pxPerSec: number, scrollSec: number, duration: number): TimeMap {
  return {
    domain: duration,
    scrollSec,
    pxPerSec,
    toX: (t) => (t - scrollSec) * pxPerSec,
    toTime: (x) => scrollSec + x / pxPerSec,
  };
}

/** Zoom anchored on a point: keep the time under the cursor exactly where it is. */
export function zoomAt(
  view: { pxPerSec: number; scrollSec: number },
  mouseX: number,
  nextPxPerSec: number,
): { pxPerSec: number; scrollSec: number } {
  const timeUnderCursor = view.scrollSec + mouseX / view.pxPerSec;
  return {
    pxPerSec: nextPxPerSec,
    scrollSec: timeUnderCursor - mouseX / nextPxPerSec,
  };
}

/** Keep the viewport inside the media. */
export function clampScroll(scrollSec: number, pxPerSec: number, viewportPx: number, duration: number): number {
  const visible = viewportPx / pxPerSec;
  const max = Math.max(0, duration - visible);
  return Math.min(max, Math.max(0, scrollSec));
}

export const MIN_PX_PER_SEC = (viewportPx: number, duration: number) =>
  duration > 0 ? viewportPx / duration : 1;
export const MAX_PX_PER_SEC = 250;

export function clampZoom(pxPerSec: number, viewportPx: number, duration: number): number {
  const min = MIN_PX_PER_SEC(viewportPx, duration);
  return Math.min(MAX_PX_PER_SEC, Math.max(min, pxPerSec));
}

// ── column classification ────────────────────────────────────────────────────

export const CUT = 0;
export const KEPT = 1;

/**
 * Which screen columns survive the edit.
 *
 * The old code asked `edl.keep.some(...)` once per column — an O(keep) scan per
 * pixel, i.e. O(width x cuts) on every repaint, four times a second, purely to
 * move a one-pixel playhead. Iterating the ranges once instead is O(keep +
 * width) and the result is reusable until the zoom or the edit changes.
 *
 * Deliberately NOT a binary search over keep[]: compileEdl's own comment states
 * that keep[] is in OUTPUT order and is not globally sorted, because that is
 * what will let paragraph reordering work later. It happens to be ascending
 * today; a bisect would silently bake in an assumption the compiler says will
 * break. Iteration is order-agnostic and faster here anyway.
 */
export function classifyColumns(edl: Edl | null, map: TimeMap, width: number): Uint8Array {
  const columns = new Uint8Array(width);
  if (!edl) {
    columns.fill(KEPT);
    return columns;
  }

  for (const range of edl.keep) {
    // Round outward so a sub-pixel range still marks the pixel it touches.
    const from = Math.max(0, Math.floor(map.toX(range.start)));
    const to = Math.min(width, Math.ceil(map.toX(range.end)));
    for (let x = from; x < to; x++) columns[x] = KEPT;
  }
  return columns;
}

// ── the ruler ────────────────────────────────────────────────────────────────

/**
 * Tick steps in seconds.
 *
 * A plain 1-2-5 decade ladder is wrong above one second, because time is
 * sexagesimal: it would offer a 50-second tick and never a 30 or a 60. This
 * ladder stays on divisions a human reads as round.
 */
const STEPS = [
  0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5,
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
];

/** Smallest step whose spacing clears `minPx`. */
export function tickStep(pxPerSec: number, minPx: number): number {
  for (const step of STEPS) {
    if (step * pxPerSec >= minPx) return step;
  }
  return STEPS[STEPS.length - 1];
}

export interface Tick {
  time: number;
  x: number;
  major: boolean;
}

export function ticks(map: TimeMap, width: number, labelPx = 80): Tick[] {
  const major = tickStep(map.pxPerSec, labelPx);
  const minor = tickStep(map.pxPerSec, 8);

  const start = map.toTime(0);
  const end = map.toTime(width);
  const out: Tick[] = [];

  // Step in integers to avoid float drift accumulating across a long ruler.
  const first = Math.floor(start / minor);
  const last = Math.ceil(end / minor);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return out;

  for (let i = first; i <= last; i++) {
    const time = i * minor;
    if (time < 0 || time > map.domain) continue;
    // Compare on the integer grid: (time % major === 0) fails on float error.
    const isMajor = Math.abs(Math.round(time / major) * major - time) < minor / 2;
    out.push({ time, x: map.toX(time), major: isMajor });
  }
  return out;
}

/**
 * HH:MM:SS.mmm, dropping the hours when the media is short.
 *
 * Not HH:MM:SS:FF. The sample media is 59.94fps NTSC, where honest frame
 * timecode is drop-frame — and this editor never exposes a frame-accurate
 * operation anyway: the EDL is word-bounded and carries float seconds. Frames
 * would be a display fiction. Descript shows no frames either, for the same
 * reason: it is a text editor.
 */
export function timecode(seconds: number, opts: { ms?: boolean; hours?: boolean } = {}): string {
  const negative = seconds < 0;

  // Work in integer milliseconds. Doing this in floats reads 885.184 as
  // 14:45.183, because 885.184 % 1 is 0.18399999…, and it also lets 59.9995
  // render as 0:59.1000 at the minute boundary.
  const totalMs = Math.round(Math.abs(seconds) * 1000);
  const ms = totalMs % 1000;
  const totalSeconds = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;

  const showHours = opts.hours ?? h > 0;
  const core = showHours ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;

  return `${negative ? '-' : ''}${core}${opts.ms ? `.${String(ms).padStart(3, '0')}` : ''}`;
}

/** Label for a ruler tick: precision follows the zoom. */
export function tickLabel(time: number, step: number): string {
  return timecode(time, { ms: step < 1 });
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

// ── playing the edit ─────────────────────────────────────────────────────────

export type PlayStep =
  | { action: 'continue' }
  | { action: 'seek'; to: number; silent: boolean }
  | { action: 'stop' };

/**
 * Seek this early, in seconds, so the jump lands inside compileEdl's padding
 * rather than after the audio we cut has already started.
 */
export const LOOKAHEAD = 0.03;

/** Below this, two ranges touch: a "cut" between them is not really a cut. */
const CONTIGUOUS = 0.001;

/**
 * What playback should do at source time `t` — the decision that skips cut
 * material without leaking any of it.
 *
 * Pure, so the rule can be tested without a video element, a media file, or a
 * browser. That is the same reason compileEdl is pure: the thing that decides
 * what you hear should be checkable without hearing it.
 *
 * The old code asked this question off `timeupdate`, which fires at ~4Hz, and
 * asked it REACTIVELY — "am I inside a cut yet?". So it only noticed up to
 * 250ms after it already was, and you heard a quarter second of every word you
 * deleted. Asking early, on rAF, and against `end - LOOKAHEAD` means the jump
 * happens while there is still kept audio playing. compileEdl already pads every
 * range by 40ms, so leaving 30ms early costs nothing that was not padding.
 */
export function playStep(edl: Edl, t: number, lookahead = LOOKAHEAD): PlayStep {
  const { keep } = edl;
  if (keep.length === 0) return { action: 'stop' };

  const i = keep.findIndex((r) => t >= r.start && t < r.end);

  // Not in kept audio at all — the user seeked into something the edit removed.
  if (i === -1) {
    const next = keep.find((r) => r.start > t);
    return next ? { action: 'seek', to: next.start, silent: true } : { action: 'stop' };
  }

  const range = keep[i];
  if (t < range.end - lookahead) return { action: 'continue' };

  const next = keep[i + 1];
  // The last kept range has run out: stop rather than play the tail the edit cut.
  if (!next) return { action: 'stop' };

  return {
    action: 'seek',
    to: next.start,
    // Muting across a boundary whose sides already touch would add an artifact
    // rather than remove one.
    silent: next.start - range.end > CONTIGUOUS,
  };
}

// ── snapping ─────────────────────────────────────────────────────────────────

/**
 * Snap to the nearest target within a PIXEL radius, so the magnet feels the same
 * at every zoom level rather than growing as you zoom in.
 */
export function snap(time: number, targets: number[], map: TimeMap, radiusPx = 8): number {
  let best = time;
  let bestDistance = radiusPx;

  for (const target of targets) {
    const distance = Math.abs(map.toX(target) - map.toX(time));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = target;
    }
  }
  return best;
}
