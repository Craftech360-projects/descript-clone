import {
  classifyColumns,
  KEPT,
  tickLabel,
  tickStep,
  ticks,
  type TimeMap,
} from '../../../../packages/core/src/timeline.ts';
import type { Edl } from '../../../../packages/core/src/types.ts';

/**
 * Canvas drawing. Split into a static layer (ruler + waveform, repainted only
 * when the view or the edit changes) and an overlay (playhead + selection,
 * repainted every frame). The old single-layer version repainted every column
 * of the waveform just to move the playhead.
 */

export interface Palette {
  kept: string;
  cut: string;
  playhead: string;
  line: string;
  faint: string;
  dim: string;
  accent: string;
  selection: string;
  chrome: string;
  ruler: string;
  film: string;
  /** The clip lane's two alternating block tints, and its label ink. */
  clipA: string;
  clipB: string;
  clipText: string;
  rulerBg: string;
  uiFont: string;
}

/** Canvas cannot read custom properties, so resolve them once per repaint. */
export function readPalette(el: HTMLElement): Palette {
  const s = getComputedStyle(el);
  const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
  // The fallbacks must track tokens.css. They are only reached if a property is
  // missing entirely, but a stale fallback is how the old blue #5b8cff outlived
  // two palettes in this exact function.
  return {
    kept: v('--wave-kept', '#c8a87a'),
    cut: v('--wave-cut', '#322b20'),
    playhead: v('--playhead', '#fdf6e8'),
    line: v('--line', '#2f281c'),
    faint: v('--faint', '#726957'),
    dim: v('--dim', '#a89e8b'),
    accent: v('--accent', '#c8a87a'),
    selection: v('--accent-dim', '#4a3a23'),
    chrome: v('--chrome', '#15110a'),
    ruler: v('--ruler-bg', '#080604'),
    film: v('--film-bg', '#000000'),
    clipA: v('--hover', '#2c2926'),
    clipB: v('--active', '#363230'),
    clipText: v('--dim', '#bdb5aa'),
    rulerBg: v('--ruler-bg', '#0a0908'),
    uiFont: v('--font-ui', 'system-ui, sans-serif'),
  };
}

export interface Geometry {
  width: number;
  height: number;
  rulerH: number;
  /** Filmstrip lane height. 0 when there is no picture to show. */
  filmH: number;
  /** Clip lane height. 0 on a single-source project, which has nothing to reorder. */
  clipH: number;
}

/**
 * The filmstrip's sheets, decoded and ready to blit.
 *
 * Held as HTMLImageElements rather than ImageBitmaps: drawImage takes either,
 * an <img> needs no decode plumbing, and the browser cache means a re-open is
 * free. The array is sparse while sheets are still loading — a missing sheet
 * draws as nothing, never as a broken tile.
 */
export interface Filmstrip {
  interval: number;
  cols: number;
  rows: number;
  tileW: number;
  tileH: number;
  count: number;
  images: (HTMLImageElement | undefined)[];
}

/**
 * Size a canvas to its CSS box in device pixels.
 *
 * Math.round matters: at the 1.25 and 1.5 device ratios Windows uses by default,
 * width * dpr is fractional (1401 * 1.25 = 1751.25) and truncating leaves the
 * canvas a fraction narrower than its box, which shears everything right.
 */
export function fitCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr: number): CanvasRenderingContext2D {
  const w = Math.round(width * dpr);
  const h = Math.round(height * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Snap to the device pixel grid so a 1px line is crisp, not a 2px smear. */
const crisp = (x: number, dpr: number) => Math.round(x * dpr) / dpr;

export function drawStatic(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  map: TimeMap,
  peaks: number[],
  edl: Edl | null,
  palette: Palette,
  dpr: number,
  film: Filmstrip | null,
): void {
  const { width, height, rulerH, filmH, clipH } = geo;
  ctx.clearRect(0, 0, width, height);

  drawRuler(ctx, geo, map, palette, dpr);
  if (film && filmH > 0) drawFilmstrip(ctx, geo, map, film, palette, edl);

  // The clip lane is drawn between the ruler and the filmstrip, so every lane
  // below it starts that much lower. drawClipLane paints its own band.
  const top = rulerH + clipH + filmH;
  const waveH = height - top;
  const mid = top + waveH / 2;
  if (waveH <= 0 || peaks.length === 0) return;

  const columns = classifyColumns(edl, map, Math.ceil(width));

  // Two Path2Ds, two fillStyle assignments — the cost here is state changes, not
  // rects, and the old loop set fillStyle once per column.
  const keptPath = new Path2D();
  const cutPath = new Path2D();

  for (let x = 0; x < width; x++) {
    const amp = peakAt(peaks, map, x, map.domain);
    const h = Math.max(1, amp * (waveH - 6));
    const path = columns[x] === KEPT ? keptPath : cutPath;
    path.rect(x, mid - h / 2, 1, h);
  }

  ctx.fillStyle = palette.cut;
  ctx.fill(cutPath);
  ctx.fillStyle = palette.kept;
  ctx.fill(keptPath);

  // Strike the cut regions so a removed pause reads as removed, not as silence.
  if (edl) drawCutStrikes(ctx, map, edl, mid, palette, dpr);

  // Mark where one clip ends and the next begins — a seam is a file boundary, not
  // an edit, so it gets its own full-height accent line rather than a cut strike.
  if (edl?.clips && edl.clips.length > 1) drawClipSeams(ctx, geo, map, edl, palette, dpr);
}

/** One clip as the lane draws it: where it sits, and what to call it. */
export interface ClipBlock {
  id: string;
  /** Start on the global source clock, in seconds. */
  offset: number;
  duration: number;
  label: string;
}

/**
 * The clip lane — the strip you pick a clip up by.
 *
 * Splitting always worked; MOVING was the gap. The only way to reorder was a
 * pair of "earlier / later" buttons buried in the Library drawer, which is not
 * where anyone looks for it: a clip is a thing on the timeline, so it should be
 * draggable on the timeline.
 *
 * Clips are a gapless SEQUENCE — every offset is the sum of the durations before
 * it — so a drag reorders rather than repositioning freely. Dropping a clip into
 * a gap is not a thing the compiler can represent, and a lane that let you try
 * would be lying about what the model can hold.
 */
export function drawClipLane(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  map: TimeMap,
  clips: ClipBlock[],
  palette: Palette,
  dpr: number,
  state: { dragId: string | null; dropIndex: number | null; hoverId: string | null },
): void {
  if (geo.clipH <= 0 || clips.length === 0) return;

  const top = geo.rulerH;
  const h = geo.clipH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, top, geo.width, h);
  ctx.clip();

  ctx.fillStyle = palette.rulerBg;
  ctx.fillRect(0, top, geo.width, h);

  clips.forEach((clip, i) => {
    const x0 = map.toX(clip.offset);
    const x1 = map.toX(clip.offset + clip.duration);
    const w = Math.max(2, x1 - x0);
    if (x1 < -20 || x0 > geo.width + 20) return;

    const dragging = state.dragId === clip.id;
    const hovered = state.hoverId === clip.id && !state.dragId;

    // Alternating tint so two adjacent clips read as two things, and the one in
    // hand reads as lifted rather than merely selected.
    ctx.globalAlpha = dragging ? 0.45 : 1;
    ctx.fillStyle = i % 2 === 0 ? palette.clipA : palette.clipB;
    ctx.fillRect(crisp(x0, dpr) + 1, top + 2, w - 2, h - 4);

    if (hovered || dragging) {
      ctx.strokeStyle = palette.accent;
      ctx.lineWidth = 1;
      ctx.strokeRect(crisp(x0, dpr) + 1.5, top + 2.5, w - 3, h - 5);
    }
    ctx.globalAlpha = 1;

    if (w > 46) {
      ctx.fillStyle = palette.clipText;
      ctx.font = `500 10px ${palette.uiFont}`;
      ctx.textBaseline = 'middle';
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 5, top, w - 10, h);
      ctx.clip();
      ctx.fillText(clip.label, x0 + 7, top + h / 2 + 0.5);
      ctx.restore();
    }
  });

  // Where the clip in hand would land. Drawn last so it sits over the blocks.
  if (state.dropIndex !== null && state.dragId) {
    const target =
      state.dropIndex >= clips.length
        ? map.toX(clips[clips.length - 1].offset + clips[clips.length - 1].duration)
        : map.toX(clips[state.dropIndex].offset);
    const x = crisp(Math.max(1, Math.min(geo.width - 1, target)), dpr);
    ctx.fillStyle = palette.accent;
    ctx.fillRect(x - 1, top, 2, h);
    ctx.beginPath();
    ctx.moveTo(x - 4, top);
    ctx.lineTo(x + 4, top);
    ctx.lineTo(x, top + 5);
    ctx.closePath();
    ctx.fill();
  }

  ctx.restore();
}

/**
 * A vertical accent line at every internal clip boundary (clip 2..N's start).
 *
 * These are the seams of a multi-clip project — where playback swaps to another
 * source file. Drawn full height, under the ruler, so they read as structure
 * spanning both the filmstrip and the waveform.
 */
function drawClipSeams(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  map: TimeMap,
  edl: Edl,
  palette: Palette,
  dpr: number,
): void {
  ctx.save();
  ctx.strokeStyle = palette.accent;
  ctx.globalAlpha = 0.8;
  ctx.lineWidth = 1;
  for (const clip of edl.clips!.slice(1)) {
    const x = crisp(map.toX(clip.offset), dpr);
    if (x < 0 || x > geo.width) continue;
    ctx.beginPath();
    ctx.moveTo(x, geo.rulerH + geo.clipH);
    ctx.lineTo(x, geo.height);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * The filmstrip lane.
 *
 * Tiles butt against each other at their natural aspect and each shows the frame
 * nearest the middle of the slot it occupies — the same rule Premiere and
 * Resolve use. That means zooming in repeats a frame rather than stretching it
 * (correct: it really is the frame for that whole span) and zooming out skips
 * frames rather than squashing them.
 *
 * The alternative — placing each tile at its own timestamp — leaves ragged gaps
 * at low zoom and overlapping tiles at high zoom, and stops being a ruler.
 */
function drawFilmstrip(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  map: TimeMap,
  film: Filmstrip,
  palette: Palette,
  edl: Edl | null,
): void {
  const { width, rulerH, filmH, clipH } = geo;
  const y = rulerH + clipH;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, y, width, filmH);
  ctx.clip();

  ctx.fillStyle = palette.film;
  ctx.fillRect(0, y, width, filmH);

  const drawW = Math.max(1, (filmH * film.tileW) / film.tileH);
  const perSheet = film.cols * film.rows;
  // Step by an integer slot index: `x += drawW` on a float accumulates error
  // across the strip and the tiles drift out of alignment.
  const slots = Math.ceil(width / drawW);

  for (let i = 0; i < slots; i++) {
    const x = i * drawW;
    const t = map.toTime(x + drawW / 2);
    if (t < 0 || t > map.domain) continue;

    const idx = Math.min(film.count - 1, Math.max(0, Math.round(t / film.interval)));
    const image = film.images[Math.floor(idx / perSheet)];
    // A sheet still in flight draws as nothing rather than as a broken tile.
    if (!image?.complete || image.naturalWidth === 0) continue;

    const cell = idx % perSheet;
    ctx.drawImage(
      image,
      (cell % film.cols) * film.tileW,
      Math.floor(cell / film.cols) * film.tileH,
      film.tileW,
      film.tileH,
      x,
      y,
      drawW,
      filmH,
    );
  }

  // Dim what the edit removes, so the strip and the waveform cannot disagree
  // about what survives. Runs are batched: one fillRect per cut region, not per
  // column.
  if (edl) {
    const columns = classifyColumns(edl, map, Math.ceil(width));
    ctx.fillStyle = 'rgb(0 0 0 / .72)';
    let from = -1;
    for (let x = 0; x <= width; x++) {
      const cut = x < width && columns[x] !== KEPT;
      if (cut && from === -1) from = x;
      else if (!cut && from !== -1) {
        ctx.fillRect(from, y, x - from, filmH);
        from = -1;
      }
    }
  }

  ctx.restore();

  ctx.fillStyle = palette.line;
  ctx.fillRect(0, y + filmH - 1, width, 1);
}

/**
 * The peak covering screen column x.
 *
 * peaks[] buckets the WHOLE file evenly, and there are 1601 of them, not 1600 —
 * the bucket stride leaves a remainder. So the index comes from the time, never
 * from `x / width * peaks.length`, which is only correct when fully zoomed out.
 */
function peakAt(peaks: number[], map: TimeMap, x: number, duration: number): number {
  if (duration <= 0) return 0;
  const t0 = map.toTime(x);
  const t1 = map.toTime(x + 1);
  const from = Math.floor((t0 / duration) * peaks.length);
  const to = Math.ceil((t1 / duration) * peaks.length);

  // Zoomed out, one column spans many buckets: take the max so transients
  // survive instead of being averaged into mush.
  let max = 0;
  for (let i = Math.max(0, from); i < Math.min(peaks.length, Math.max(to, from + 1)); i++) {
    const p = peaks[i];
    if (p > max) max = p;
  }
  return max;
}

function drawCutStrikes(
  ctx: CanvasRenderingContext2D,
  map: TimeMap,
  edl: Edl,
  mid: number,
  palette: Palette,
  dpr: number,
): void {
  ctx.strokeStyle = palette.cut;
  ctx.lineWidth = 1;
  ctx.beginPath();

  const y = crisp(mid, dpr) + 0.5 / dpr;
  let cursor = 0;
  for (const range of edl.keep) {
    if (range.start > cursor) {
      ctx.moveTo(map.toX(cursor), y);
      ctx.lineTo(map.toX(range.start), y);
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < edl.sourceDuration) {
    ctx.moveTo(map.toX(cursor), y);
    ctx.lineTo(map.toX(edl.sourceDuration), y);
  }
  ctx.stroke();
}

function drawRuler(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  map: TimeMap,
  palette: Palette,
  dpr: number,
): void {
  const { width, rulerH } = geo;

  ctx.fillStyle = palette.ruler;
  ctx.fillRect(0, 0, width, rulerH);

  const step = tickStep(map.pxPerSec, 80);
  const list = ticks(map, width, 80);

  // Match the shell: the ruler is chrome, and chrome is Inter now. tabular-nums
  // stops the labels jittering as the digits change under a scrub.
  ctx.font = '500 10px Inter, ui-sans-serif, system-ui, sans-serif';
  ctx.fontVariantCaps = 'normal';
  ctx.textBaseline = 'top';

  ctx.beginPath();
  ctx.strokeStyle = palette.line;
  ctx.lineWidth = 1;

  for (const tick of list) {
    const x = crisp(tick.x, dpr) + 0.5 / dpr;
    const h = tick.major ? 8 : 4;
    ctx.moveTo(x, rulerH - h);
    ctx.lineTo(x, rulerH);

    if (tick.major) {
      ctx.fillStyle = palette.faint;
      ctx.fillText(tickLabel(tick.time, step), tick.x + 3, 2);
    }
  }
  ctx.stroke();

  ctx.beginPath();
  ctx.strokeStyle = palette.line;
  ctx.moveTo(0, crisp(rulerH, dpr) + 0.5 / dpr);
  ctx.lineTo(width, crisp(rulerH, dpr) + 0.5 / dpr);
  ctx.stroke();
}

export interface Overlay {
  currentTime: number;
  selection: { start: number; end: number } | null;
  hoverTime: number | null;
}

/**
 * The per-frame layer. A clearRect and a handful of rects — this is what makes
 * a 60Hz playhead affordable.
 */
export function drawOverlay(
  ctx: CanvasRenderingContext2D,
  geo: Geometry,
  map: TimeMap,
  state: Overlay,
  palette: Palette,
  dpr: number,
): void {
  const { width, height, rulerH } = geo;
  ctx.clearRect(0, 0, width, height);

  if (state.selection) {
    const from = map.toX(state.selection.start);
    const to = map.toX(state.selection.end);
    ctx.fillStyle = palette.selection;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(from, rulerH, Math.max(1, to - from), height - rulerH);
    ctx.globalAlpha = 1;

    ctx.fillStyle = palette.accent;
    ctx.fillRect(crisp(from, dpr), rulerH, 1, height - rulerH);
    ctx.fillRect(crisp(to, dpr), rulerH, 1, height - rulerH);
  }

  if (state.hoverTime !== null) {
    ctx.fillStyle = palette.line;
    ctx.fillRect(crisp(map.toX(state.hoverTime), dpr), rulerH, 1, height - rulerH);
  }

  const x = crisp(map.toX(state.currentTime), dpr);
  if (x >= -1 && x <= width + 1) {
    ctx.fillStyle = palette.playhead;
    ctx.fillRect(x, 0, 1, height);
    // A head on the playhead, so it is findable at a glance in a dense waveform.
    ctx.beginPath();
    ctx.moveTo(x - 4, 0);
    ctx.lineTo(x + 4, 0);
    ctx.lineTo(x, 6);
    ctx.closePath();
    ctx.fill();
  }
}
