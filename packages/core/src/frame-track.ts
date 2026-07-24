/**
 * The frame as a function of TIME: mark a portion of the picture and push in on
 * it for part of the video, optionally following it as it moves.
 *
 * Everything else in this app that shapes the picture is one value for the whole
 * output — one crop, one grade, one speed. This is the first parameter that is
 * animated, and the design is mostly about paying for that once rather than at
 * every layer.
 *
 * ── the composition, and why the punch rides ON TOP of the frame ──────────────
 *
 * FrameSettings already decides what shape the video is and which part of the
 * source fills it, as a static scale/pad/crop (see frameFilterStages). A move
 * does NOT reopen that decision — it punches into the FINISHED frame:
 *
 *     source ──frameFilterStages──▶ W×H frame ──moves──▶ W×H frame
 *
 * That is a real constraint and it buys three things:
 *
 *  - Zoom is always ≥ 1, so the punch never has to invent black bars that the
 *    static pad would have to place — and pad's offsets are evaluated once at
 *    filter configuration, so an animated one is not expressible at all.
 *  - It composes with every preset. A reel that is already letterboxed punches
 *    in on the letterboxed picture, which is what you see and what you get.
 *  - The preview is a plain CSS transform over the frame box, so the monitor and
 *    the render are the same two numbers rather than two pipelines.
 *
 * The cost, stated plainly: on a source with more pixels than the output — 4K
 * into a 1080p reel — a punch upscales the delivered frame instead of spending
 * the source detail that a static crop of the same size would have kept. Every
 * NLE that punches in on a timeline does the same thing.
 *
 * ── why a move is a REGION with a strength, not a bare keyframe list ──────────
 *
 * The gesture is "hold on that face from here to here, easing in and out". Spelt
 * as bare keyframes that is four keys whose first and last must be kept exactly
 * equal to the resting frame or the picture drifts, and every edit to the target
 * has to touch two of them. Spelt as a region it is one object with one target.
 *
 * So a move carries its framing and its own ramp, and the value at time t is
 *
 *     punch(t) = lerp(rest, framing(t), strength(t))
 *
 * with `strength` a smoothstep that is 0 outside the region. `framing` is either
 * a held value or — once a tracker has run — a path of samples. That split is
 * the whole reason tracking is not a second system: the tracker only fills
 * `path`, and the ease, the compositing and the render are untouched.
 *
 * ── why the ffmpeg spelling is a SUM and not nested ifs ───────────────────────
 *
 * See punchFilterStage. A tracked move is tens of samples, and the obvious
 * `if(lt(t,a),…,if(lt(t,b),…))` nests one level per sample — a recursive parse
 * that gets deep enough to be a liability for a thing that only has to be a
 * piecewise line. Hinge form (see hingeBasis) is the same function written flat.
 */

import type { FrameLayout } from './frame.ts';

/** One tracked sample: where the marked thing is, at a source timestamp. */
export interface FramePoint {
  /** Seconds into the SOURCE (global) timeline — see the clock note below. */
  t: number;
  /**
   * Where the punch window sits, per axis, as -1..1 — the SAME convention as
   * FrameSettings.x/y, so a reader who knows one knows the other. 0 is centred
   * on the frame, ±1 is hard against an edge.
   */
  x: number;
  y: number;
}

/**
 * One push-in: a stretch of the source, a framing to hold across it, and how
 * long it takes to get there and back.
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 *
 * start/end/path[].t are SOURCE (global) timestamps, the same clock every Word
 * carries and the same one the EDL is cut on. They are deliberately not output
 * timestamps, even though the render's crop is evaluated on the output clock and
 * has to be mapped there (movesToOutput).
 *
 * The reason is that a move is attached to CONTENT. Cut a sentence out ahead of
 * a push-in and the push-in must still land on the face it was aimed at; stored
 * on the output clock it would slide backwards by exactly the length of the cut,
 * every time, silently. It also makes the preview trivial — the <video> element
 * plays the source, so the monitor samples this with no mapping at all.
 */
export interface FrameMove {
  /** Stable id, so the panel and the monitor can talk about the same move. */
  id: string;
  /** Source (global) seconds. Half-open [start, end), start < end. */
  start: number;
  end: number;
  /**
   * Seconds of ramp at EACH end. Clamped to half the region, so a 0.4s move with
   * a 1s ease is a triangle rather than an error.
   *
   * A hard cut to a different framing is a legitimate look and 0 gives it.
   */
  ease: number;
  /** How far in, over the finished frame. 1 is no push-in at all. */
  zoom: number;
  /** The framing held across the region, when `path` is empty. -1..1 per axis. */
  x: number;
  y: number;
  /**
   * The rectangle that was actually dragged over the picture, in frame
   * coordinates — as opposed to the shot it resolved to.
   *
   * These are not the same rectangle and the difference is the whole reason this
   * is stored. boxToPunch CONTAINS the mark in the frame's own aspect, so a tall
   * mark on a 16:9 frame becomes a much wider window. Handing that window to the
   * tracker as its template would be handing it the subject plus a lap of
   * background on either side, and background does not move with the subject —
   * it dilutes exactly the signal the correlation is looking for.
   *
   * Absent on a move whose framing was set by the sliders rather than by a
   * marquee; the tracker then falls back to the delivered window, which is the
   * best available answer rather than a good one.
   */
  mark?: FrameBox;
  /**
   * Where the marked thing actually is, sampled over time — the tracker's
   * output. Empty means the framing above is held still, which is the state a
   * move is created in and the state it stays in unless you ask it to follow.
   *
   * Non-empty REPLACES x/y for any t the path spans; outside it the nearest end
   * of the path holds. Kept beside x/y rather than overwriting them so that
   * clearing a track restores the framing you set by hand.
   */
  path: FramePoint[];
}

/** A resolved punch: no region, no ramp, just what the frame is doing now. */
export interface Punch {
  /** ≥ 1. 1 exactly is "the finished frame, untouched". */
  zoom: number;
  x: number;
  y: number;
}

/** The resting state: the frame as FrameSettings alone would deliver it. */
export const REST: Punch = { zoom: 1, x: 0, y: 0 };

/**
 * The tightest push-in offered.
 *
 * 4x on a 1080-wide frame is a 270px-wide window blown back up to 1080, which is
 * already past where a punch reads as a choice and into where it reads as a
 * mistake. It is also MAX_ZOOM in frame.ts, and one number for "as far in as
 * this app goes" beats two.
 */
export const MAX_PUNCH_ZOOM = 4;
export const MIN_PUNCH_ZOOM = 1;

/**
 * The shortest move worth having, in seconds.
 *
 * Below this the ease has no room and the push-in reads as a glitch rather than
 * a move. It is also the floor the region gets clamped to when a word selection
 * is a single short word.
 */
export const MIN_MOVE_SEC = 0.3;

/** Default ramp. Long enough to read as a move, short enough not to be a wait. */
export const DEFAULT_EASE_SEC = 0.5;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Smoothstep: 0 below `a`, 1 above `b`, and an S-curve between.
 *
 * The S matters more than it looks. A linear ramp into a push-in starts and
 * stops instantly — the picture is still, then it is moving at full speed, which
 * reads as a camera being shoved. Smoothstep has zero derivative at both ends,
 * so the move begins and ends at rest. It is also the cheapest curve that does
 * (one multiply-add over u²), and it is expressible verbatim in ffmpeg's
 * expression language, which the emitter below depends on.
 *
 * A zero-length ramp is a step, not a division by zero.
 */
export function smoothstep(a: number, b: number, t: number): number {
  if (b <= a) return t < a ? 0 : 1;
  const u = clamp((t - a) / (b - a), 0, 1);
  return u * u * (3 - 2 * u);
}

/** The ease a move actually gets: never more than half the region. */
export function easeOf(move: FrameMove): number {
  return clamp(move.ease, 0, (move.end - move.start) / 2);
}

/**
 * How much of this move is in effect at time t — 0 outside it, 1 across its
 * middle, an S-curve in between.
 *
 * Written as the PRODUCT of a rising and a falling smoothstep rather than as a
 * branch, because the same shape then survives being translated into an ffmpeg
 * expression with no `if` at all: outside the region one of the two factors is
 * exactly 0, so the product is 0 without anyone having to test for it.
 */
export function moveStrength(move: FrameMove, t: number): number {
  const ease = easeOf(move);
  const rise = smoothstep(move.start, move.start + ease, t);
  const fall = 1 - smoothstep(move.end - ease, move.end, t);
  return rise * fall;
}

/**
 * Where the move is looking at time t: the tracked path if it has one, else the
 * framing it was given.
 *
 * The path holds at both ends rather than extrapolating. A tracker that ran over
 * the middle 80% of a region has no opinion about the other 20%, and inventing
 * one by continuing the last two samples' slope is how a follow ends up sliding
 * off the subject just as the move eases out.
 */
export function samplePath(move: FrameMove, t: number): { x: number; y: number } {
  const path = move.path;
  if (path.length === 0) return { x: move.x, y: move.y };
  if (path.length === 1 || t <= path[0].t) return { x: path[0].x, y: path[0].y };
  const last = path[path.length - 1];
  if (t >= last.t) return { x: last.x, y: last.y };

  for (let i = 1; i < path.length; i++) {
    const b = path[i];
    if (t > b.t) continue;
    const a = path[i - 1];
    const span = b.t - a.t;
    // Two samples at the same instant would divide by zero; take the later one.
    const u = span > 0 ? (t - a.t) / span : 1;
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u };
  }
  return { x: last.x, y: last.y };
}

/**
 * What the frame is doing at source time t, across every move.
 *
 * THE function — the monitor calls it 60 times a second and punchFilterStage is
 * a spelling of it in ffmpeg's expression language. If those two ever disagree,
 * the app is showing a crop it will not ship, which is the exact failure this
 * module is arranged to make impossible.
 *
 * Moves are summed rather than searched. They are held non-overlapping by
 * normalizeMoves, so at most one has a non-zero strength at any t and the sum is
 * that one's value — but writing it as a sum means the ffmpeg side can be a sum
 * too, and a sum has no branch to get wrong.
 */
export function samplePunch(moves: FrameMove[], t: number): Punch {
  let zoom = 1;
  let x = 0;
  let y = 0;

  for (const move of moves) {
    const s = moveStrength(move, t);
    if (s <= 0) continue;
    const at = samplePath(move, t);
    // lerp from rest, so a move at half strength is half way in AND half way
    // across. Ramping only the zoom would swing the picture sideways at full
    // speed while it was still growing.
    zoom += (move.zoom - 1) * s;
    x += at.x * s;
    y += at.y * s;
  }

  return { zoom, x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
}

/** True when these moves would change nothing — then nothing is emitted at all. */
export function isRestingTrack(moves: FrameMove[]): boolean {
  return moves.every((m) => m.end - m.start <= 0 || m.zoom <= MIN_PUNCH_ZOOM + 1e-6);
}

// ── coercion ──────────────────────────────────────────────────────────────────

/**
 * Coerce anything off the wire or off disk into usable moves.
 *
 * Same contract as normalizeFrame and normalizeColor: per field, not per object.
 * Then two things those do not have to do —
 *
 *  - SORT by start, because everything downstream (the panel's list, the
 *    overlap test, the emitter's sum) reads better in time order and nothing
 *    guarantees the client sent them that way.
 *  - DROP OVERLAPS, keeping the earlier move. Two moves live at once would sum
 *    their zooms and land somewhere neither asked for, and there is no sensible
 *    blend of "push in on her" and "push in on him". The editor prevents it; this
 *    is the layer that makes it unrepresentable.
 */
export function normalizeMoves(input?: unknown): FrameMove[] {
  if (!Array.isArray(input)) return [];

  const cleaned: FrameMove[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const m = raw as Partial<FrameMove>;
    const start = Math.max(0, num(m.start, 0));
    const end = Math.max(start, num(m.end, 0));
    if (end - start < MIN_MOVE_SEC) continue;

    cleaned.push({
      id: typeof m.id === 'string' && m.id ? m.id : `mv${cleaned.length}`,
      start,
      end,
      ease: clamp(num(m.ease, DEFAULT_EASE_SEC), 0, (end - start) / 2),
      zoom: clamp(num(m.zoom, 1), MIN_PUNCH_ZOOM, MAX_PUNCH_ZOOM),
      x: clamp(num(m.x, 0), -1, 1),
      y: clamp(num(m.y, 0), -1, 1),
      // Optional, and it stays optional: writing `mark: undefined` would make an
      // untouched move stop round-tripping to an equal object, and isEmptyPatch
      // compares these by value.
      ...(normalizeBox(m.mark) ? { mark: normalizeBox(m.mark)! } : {}),
      path: normalizePath(m.path, start, end),
    });
  }

  cleaned.sort((a, b) => a.start - b.start);

  const out: FrameMove[] = [];
  for (const move of cleaned) {
    const prev = out[out.length - 1];
    if (prev && move.start < prev.end) continue;
    out.push(move);
  }
  return out;
}

/**
 * A marked rectangle off the wire, or undefined if there is not a usable one.
 *
 * Clamped INTO the frame rather than merely range-checked: a box is dragged with
 * a pointer that can leave the picture, and half a rectangle outside the frame
 * would have the tracker cut a template partly out of pixels that do not exist.
 */
function normalizeBox(input: unknown): FrameBox | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const b = input as Partial<FrameBox>;
  const x = clamp(num(b.x, 0), 0, 1);
  const y = clamp(num(b.y, 0), 0, 1);
  const width = clamp(num(b.width, 0), 0, 1 - x);
  const height = clamp(num(b.height, 0), 0, 1 - y);
  if (width <= 0 || height <= 0) return undefined;
  return { x, y, width, height };
}

/**
 * Tracked samples, sorted and clamped into their move.
 *
 * Samples outside the region are dropped rather than clamped onto its edge: a
 * tracker that overran has no business moving the framing at a time the move is
 * not in effect, and stacking several strays onto the same timestamp would make
 * samplePath's interpolation depend on their order.
 */
function normalizePath(input: unknown, start: number, end: number): FramePoint[] {
  if (!Array.isArray(input)) return [];
  const points: FramePoint[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const p = raw as Partial<FramePoint>;
    const t = num(p.t, NaN);
    if (!Number.isFinite(t) || t < start || t > end) continue;
    points.push({ t, x: clamp(num(p.x, 0), -1, 1), y: clamp(num(p.y, 0), -1, 1) });
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

// ── editing ───────────────────────────────────────────────────────────────────

/** A move over [start, end), framed dead centre until you frame it. */
export function createMove(start: number, end: number, id: string): FrameMove {
  const from = Math.max(0, start);
  const to = Math.max(from + MIN_MOVE_SEC, end);
  return {
    id,
    start: from,
    end: to,
    ease: Math.min(DEFAULT_EASE_SEC, (to - from) / 2),
    // 1.4x rather than 1: a move that does nothing until you also drag a box is
    // a control that appears broken. This is a visible push-in on the middle of
    // the frame, which is both a sane default and a demonstration of the verb.
    zoom: 1.4,
    x: 0,
    y: 0,
    path: [],
  };
}

/**
 * Add a move, refusing one that would overlap an existing one.
 *
 * Returns the ORIGINAL array when it cannot place the move, so the caller's
 * no-op test (and therefore the undo stack) needs no special case.
 */
export function addMove(moves: FrameMove[], move: FrameMove): FrameMove[] {
  const clash = moves.some((m) => move.start < m.end && m.start < move.end);
  if (clash) return moves;
  return [...moves, move].sort((a, b) => a.start - b.start);
}

export function updateMove(moves: FrameMove[], id: string, patch: Partial<FrameMove>): FrameMove[] {
  return moves.map((m) => (m.id === id ? { ...m, ...patch } : m));
}

export function removeMove(moves: FrameMove[], id: string): FrameMove[] {
  return moves.filter((m) => m.id !== id);
}

/** The move covering source time t, if any — what the monitor is editing. */
export function moveAt(moves: FrameMove[], t: number): FrameMove | null {
  return moves.find((m) => t >= m.start && t < m.end) ?? null;
}

// ── the marked box ────────────────────────────────────────────────────────────
//
// Marking is a rectangle dragged over the picture, and a punch is a zoom and a
// pan. These two convert between them, and they are each other's inverse
// wherever the box is reachable — which is most of them, since a box of a
// different SHAPE from the frame cannot be delivered by a crop that preserves
// the frame's aspect. Where they differ, boxToPunch keeps ALL of the marked box
// and takes more of the other axis, which is the only direction that cannot lose
// something the user pointed at.

/** A rectangle over the frame, each field a fraction of the frame's own size. */
export interface FrameBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The tightest punch that still contains the marked box.
 *
 * `min` is what makes it contain rather than crop: filling the box on the
 * tighter axis would spill the other one off the frame. The centre is then
 * solved for exactly — the window is 1/zoom of the frame, so putting its middle
 * on the box's middle fixes the pan, and the clamp handles a box marked so close
 * to an edge that the window would have to leave the picture to be centred on it.
 */
export function boxToPunch(box: FrameBox, maxZoom = MAX_PUNCH_ZOOM): Punch {
  const w = clamp(box.width, 1e-4, 1);
  const h = clamp(box.height, 1e-4, 1);
  const zoom = clamp(Math.min(1 / w, 1 / h), MIN_PUNCH_ZOOM, maxZoom);

  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return { zoom, ...centreOn(cx, cy, zoom) };
}

/**
 * The pan that puts (cx, cy) — a point in frame coordinates — in the middle of
 * the punched window.
 *
 * The window spans 1/zoom of the frame and its left edge travels (1 - 1/zoom) as
 * the pan runs -1..1, so this is one division. At zoom 1 there is no travel and
 * no pan can move anything, which is why that case answers 0 rather than
 * dividing by it.
 */
export function centreOn(cx: number, cy: number, zoom: number): { x: number; y: number } {
  const travel = 1 - 1 / zoom;
  if (travel <= 0) return { x: 0, y: 0 };
  const fx = (cx - 1 / (2 * zoom)) / travel;
  const fy = (cy - 1 / (2 * zoom)) / travel;
  return { x: clamp(fx * 2 - 1, -1, 1), y: clamp(fy * 2 - 1, -1, 1) };
}

/** The window a punch delivers, in frame coordinates — for drawing the marker. */
export function punchToBox(punch: Punch): FrameBox {
  const size = 1 / Math.max(punch.zoom, MIN_PUNCH_ZOOM);
  const travel = 1 - size;
  return {
    x: travel * ((punch.x + 1) / 2),
    y: travel * ((punch.y + 1) / 2),
    width: size,
    height: size,
  };
}

// ── the preview ───────────────────────────────────────────────────────────────

/**
 * The punch, applied to the layout frameLayout already computed — the monitor's
 * half of punchFilterStage.
 *
 * A punch scales the whole frame box about the top-left of the window it keeps,
 * so a point p in frame coordinates lands at (p - offset) * zoom. The picture is
 * positioned inside that same box, so it takes exactly the same map, and the
 * result is still an ordinary left/top/width/height — no transform to unpick and
 * nothing for the caption overlay (which is NOT punched: captions belong to the
 * delivered frame) to have to opt out of.
 *
 * The travels come along for the ride. They are the denominator that converts a
 * drag in pixels into a change in pan, and inside a punch a pixel of drag is
 * worth `zoom` times less.
 */
export function punchLayout(
  layout: FrameLayout,
  punch: Punch,
  box: { width: number; height: number },
): FrameLayout {
  const z = punch.zoom;
  if (z <= 1 + 1e-6) return layout;

  const offX = box.width * (1 - 1 / z) * ((punch.x + 1) / 2);
  const offY = box.height * (1 - 1 / z) * ((punch.y + 1) / 2);

  return {
    width: layout.width * z,
    height: layout.height * z,
    left: (layout.left - offX) * z,
    top: (layout.top - offY) * z,
    travelX: layout.travelX * z,
    travelY: layout.travelY * z,
  };
}

// ── the render ────────────────────────────────────────────────────────────────

/**
 * A piecewise-linear function of time, written as a starting value plus a set of
 * slope CHANGES — the "hinge" form.
 *
 * f(t) = v0 + Σ k_i · max(0, t - t_i)
 *
 * This is the same function samplePath computes by searching for the containing
 * pair, rearranged so that it can be spelt as a flat sum. Every hinge is inert
 * until its own timestamp (max(0, …) is exactly 0 before it) and contributes a
 * constant slope after it, so the sum through any interval is the line that
 * interval wants. Both spellings are generated from this one basis, which is
 * what stops the render and the preview drifting apart — the same trick color.ts
 * uses to keep its filtergraph and its SVG on one set of coefficients.
 *
 * The caller must clamp t into [first, last] before evaluating: hinges describe
 * the interior, and beyond the last one the final slope would run on forever.
 */
export interface Hinges {
  v0: number;
  /** Where the slope changes, and by how much. In ascending time order. */
  hinges: Array<{ t: number; k: number }>;
}

export function hingeBasis(points: Array<{ t: number; v: number }>): Hinges {
  if (points.length === 0) return { v0: 0, hinges: [] };
  const v0 = points[0].v;
  const hinges: Array<{ t: number; k: number }> = [];
  let prevSlope = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const span = b.t - a.t;
    if (span <= 0) continue;
    const slope = (b.v - a.v) / span;
    hinges.push({ t: a.t, k: slope - prevSlope });
    prevSlope = slope;
  }
  return { v0, hinges };
}

/** Evaluate a hinge basis. Used by the tests to prove the two spellings agree. */
export function evalHinges(basis: Hinges, t: number): number {
  let v = basis.v0;
  for (const h of basis.hinges) v += h.k * Math.max(0, t - h.t);
  return v;
}

/**
 * A move whose times have been mapped onto the OUTPUT clock, ready to emit.
 *
 * The distinction is the whole reason this type exists rather than reusing
 * FrameMove: a FrameMove is addressed in source time, and the filter that
 * applies it runs after the cut, where the only clock is the output's.
 */
export type OutputMove = FrameMove;

/**
 * Move the whole track onto the output clock.
 *
 * `mapTime` is sourceToOutput bound to the EDL — passed in rather than imported
 * so this module keeps knowing nothing about EDLs, and so the caller decides
 * what an unmappable time means.
 *
 * A move whose ENDS were cut still plays across whatever survived in the middle,
 * which is the behaviour that makes moves survive editing at all: trimming the
 * first second off a push-in should shorten it, not delete it. Only a move with
 * nothing left is dropped. The ease is rescaled with the region for the same
 * reason — a 0.5s ramp on a region the edit shortened to 0.6s has to shrink or
 * it is the whole move.
 */
export function movesToOutput(
  moves: FrameMove[],
  mapTime: (t: number) => number | null,
  probe: (from: number, to: number) => number | null = () => null,
): OutputMove[] {
  const out: OutputMove[] = [];

  for (const move of moves) {
    // A cut end has no output time of its own; walk inwards for the first moment
    // of this move that survived.
    const start = mapTime(move.start) ?? probe(move.start, move.end);
    const end = mapTime(move.end) ?? probe(move.end, move.start);
    if (start === null || end === null) continue;
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    if (hi - lo < MIN_MOVE_SEC) continue;

    const kept = (hi - lo) / Math.max(move.end - move.start, 1e-6);
    const path: FramePoint[] = [];
    for (const p of move.path) {
      const t = mapTime(p.t);
      // A sample inside a cut is simply gone — samplePath interpolates across the
      // hole, which is what the picture does too.
      if (t === null || t < lo || t > hi) continue;
      path.push({ t, x: p.x, y: p.y });
    }

    out.push({
      ...move,
      start: lo,
      end: hi,
      ease: Math.min(easeOf(move) * Math.min(kept, 1), (hi - lo) / 2),
      path,
    });
  }

  return out;
}

/**
 * The filtergraph stage that animates the punch, or null when there is nothing
 * to animate.
 *
 * Null is the important half, exactly as it is in resolveFrame and resolveColor:
 * a project with no moves emits no filter, so its export is byte-identical to
 * one from before this existed.
 *
 * ── why zoompan ──────────────────────────────────────────────────────────────
 *
 * Because it is the only filter that can change the size of the window it keeps,
 * per frame. This was not a preference:
 *
 *  - `crop` re-evaluates x and y for every frame but computes w and h ONCE at
 *    configuration. Verified against ffmpeg 8.1: `crop=w='320+100*t'` does not
 *    animate, it fails the graph outright with EINVAL.
 *  - `scale` accepts eval=frame, but a scale whose output size changes per frame
 *    is a stream whose frames disagree on their dimensions, which no encoder will
 *    take.
 *  - `pad` is configuration-time on both counts, which is the other half of why
 *    the punch is defined to sit on top of a finished frame and never to zoom
 *    out: black bars would need an animated pad, and there is no such thing.
 *
 * zoompan scales its input by `zoom` and takes an `s`-sized window at (x, y),
 * re-deciding all three every frame. Feeding it the delivered frame and asking
 * for the same size back makes it exactly the punch: at zoom 1 it hands back
 * what it was given.
 *
 * ── the expressions ──────────────────────────────────────────────────────────
 *
 *   z = 1 + Σ (zoom_m - 1) · s_m(t)
 *   x = (iw·zoom - ow) · (Σ x_m(t)·s_m(t) + 1)/2      and y likewise
 *
 * `in_time` and not `t`: zoompan's clock variable is the input frame's own
 * timestamp, and it reads the REAL pts (verified — offsetting the input by 5s
 * shifts the result). The stream reaching this filter has already been
 * renumbered from zero by the cut's setpts, so in_time is output seconds, which
 * is the clock movesToOutput put these moves on.
 *
 * `zoom` inside x and y is zoompan's own just-computed value, so the pan is
 * expressed against the window that this frame is actually keeping. Solving that
 * in JS instead would need the input size, which the graph deliberately does not
 * know — see the note about expressions in frameFilterStages.
 *
 * Commas are NOT escaped here, unlike frameFilterStages. Every expression is
 * inside single quotes, and quoting protects the filtergraph's argument split;
 * frameFilterStages escapes because its max() sits in an unquoted argument.
 * Verified against ffmpeg 8.1 with an if() carrying commas.
 */
export function punchFilterStage(
  moves: OutputMove[],
  out: { width: number; height: number },
  fps: number,
): string | null {
  const live = moves.filter((m) => m.end - m.start > 0 && m.zoom > MIN_PUNCH_ZOOM + 1e-6);
  if (live.length === 0) return null;
  // zoompan generates its own output timestamps from this rate, so a wrong one
  // is a wrong-length video rather than a wrong-looking one. The caller probes.
  if (!(fps > 0)) return null;

  const zTerms: string[] = [];
  const xTerms: string[] = [];
  const yTerms: string[] = [];

  for (const move of live) {
    const s = strengthExpr(move);
    zTerms.push(`(${n(move.zoom - 1)})*${s}`);
    xTerms.push(`${pathExpr(move, 'x')}*${s}`);
    yTerms.push(`${pathExpr(move, 'y')}*${s}`);
  }

  const z = `1+${zTerms.join('+')}`;
  // -1..1 -> 0..1, the fraction of the travel taken on the left/top — the same
  // conversion frameFilterStages does, and the reason the two panels' numbers
  // mean the same thing.
  const fx = `((${clampExpr(xTerms.join('+'))})+1)/2`;
  const fy = `((${clampExpr(yTerms.join('+'))})+1)/2`;

  return (
    `zoompan=z='${z}':x='(iw*zoom-ow)*(${fx})':y='(ih*zoom-oh)*(${fy})':` +
    `d=1:s=${out.width}x${out.height}:fps=${n(fps)}`
  );
}

/**
 * moveStrength, in ffmpeg's expression language.
 *
 * The product of a rising and a falling smoothstep, with `clip` doing the
 * clamping that JS does with Math.min/max — so outside the region one factor is
 * exactly 0 and the term contributes nothing without a branch existing anywhere.
 *
 * The falling edge is spelt `1 - rise` rather than as a ramp run backwards, and
 * that is not cosmetic: reversed, a ZERO-length ease has no direction left to
 * read, and the degenerate case came out as gte(t, end) — a move that switched
 * on at its own end and stayed on forever. Mirroring moveStrength's own
 * arithmetic instead means the two cannot disagree about which side of a hard
 * cut is which. The frame-by-frame test catches exactly this.
 */
function strengthExpr(move: FrameMove): string {
  const ease = easeOf(move);
  const rise = rampExpr(move.start, move.start + ease);
  const fall = rampExpr(move.end - ease, move.end);
  return `(${rise})*(1-(${fall}))`;
}

/** A smoothstep from `a` to `b`: 0 at or below a, 1 at or above b. */
function rampExpr(a: number, b: number): string {
  if (Math.abs(b - a) < 1e-6) return `gte(in_time,${n(a)})`;
  const u = `clip((in_time-${n(a)})/(${n(b - a)}),0,1)`;
  // u²(3-2u), written with the sub-expression repeated rather than stored with
  // st()/ld(): the eval state is per-expression and zoompan evaluates z, x and y
  // separately, so a stored slot would not survive the crossing anyway.
  return `(${u})*(${u})*(3-2*(${u}))`;
}

/**
 * One move's tracked path on one axis, as a flat sum of hinges.
 *
 * `clip` on the time is what makes the ends HOLD rather than extrapolate —
 * exactly what samplePath does by returning the first and last samples outside
 * their range, and for the same reason. A held value needs no hinges at all.
 */
function pathExpr(move: FrameMove, axis: 'x' | 'y'): string {
  const held = axis === 'x' ? move.x : move.y;
  if (move.path.length === 0) return `(${n(held)})`;
  if (move.path.length === 1) return `(${n(move.path[0][axis])})`;

  const points = move.path.map((p) => ({ t: p.t, v: p[axis] }));
  const basis = hingeBasis(points);
  const first = points[0].t;
  const last = points[points.length - 1].t;
  const t = `clip(in_time,${n(first)},${n(last)})`;

  const terms = basis.hinges
    .filter((h) => Math.abs(h.k) > 1e-9)
    .map((h) => `(${n(h.k)})*max(0,${t}-${n(h.t)})`);
  if (terms.length === 0) return `(${n(basis.v0)})`;
  return `(${n(basis.v0)}+${terms.join('+')})`;
}

/** Pan is meaningless outside -1..1, and zoompan would clamp it anyway. */
function clampExpr(sum: string): string {
  return `clip(${sum},-1,1)`;
}

/**
 * ffmpeg wants plain decimals, never exponential notation — and 4 places is what
 * every other emitter in this codebase rounds to, so a value that crosses into
 * the graph is compared at the same precision on both sides.
 */
function n(value: number): string {
  return value.toFixed(4);
}

/** A label for the history entry a move change writes. */
export function moveLabel(move: FrameMove, verb: string): string {
  return `${verb} push-in at ${fmt(move.start)}`;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
