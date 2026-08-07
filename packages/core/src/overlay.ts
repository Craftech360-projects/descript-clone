/**
 * Images laid over the picture for a stretch of the transcript — B-roll, keyed
 * to the words that motivate it.
 *
 * The gesture this exists for: point at the word "robot", pick an image, and
 * have it appear while that word is said. So the thing being edited is a RANGE
 * OF WORDS, and everything below follows from taking that literally.
 *
 * ── why this is a sibling of frame-track.ts and not a part of it ──────────────
 *
 * A push-in and an image insert are the same SHAPE — a timed region on the
 * source clock, with a ramp at each end, previewed at 60Hz and emitted into a
 * filtergraph. They are not the same THING: a push-in re-frames pixels that are
 * already there, an overlay composites new pixels on top. Sharing the shape is
 * worth a lot (the clock argument below is copied wholesale, and `smoothstep` is
 * imported rather than rewritten); sharing a type would mean one record with two
 * disjoint halves and a discriminator.
 *
 * ── the clock ────────────────────────────────────────────────────────────────
 *
 * start/end are SOURCE (global) timestamps — the same clock every Word carries
 * and the same one the EDL is cut on. Identical reasoning to FrameMove: an
 * overlay is attached to CONTENT. Cut a sentence out ahead of an image and the
 * image must still land on the word it was aimed at; stored on the output clock
 * it would slide backwards by exactly the length of the cut, every time,
 * silently. It also makes the preview trivial — the <video> element plays the
 * source, so the monitor samples this with no mapping at all.
 *
 * The render is the side that pays: it composites AFTER the cut, where the only
 * clock is the output's, so overlaysToOutput maps them over exactly as
 * movesToOutput does for push-ins.
 *
 * ── why the opacity ramp is LINEAR and the motion ramp is not ────────────────
 *
 * These disagree on purpose, and the reason is that one of them has to match a
 * filter we do not control.
 *
 * Opacity is spelt in the render as ffmpeg's `fade` filter with `alpha=1`, which
 * is a LINEAR ramp and has no shaping parameter. Measured against ffmpeg 8.0: a
 * 0.5s fade-in over a red image sampled at its midpoint reads 134/252 — 53%, a
 * straight line. So `overlayFade` is linear too, because the alternative is a
 * preview that dissolves on a different curve from the file.
 *
 * Motion (the slide transitions) is spelt as a per-frame expression in
 * `overlay`'s own x/y, which CAN carry a smoothstep — verified against ffmpeg
 * 8.0, where a slide sampled at t=2.267 through a 0.5s ramp put the image's left
 * edge at -145px against a predicted -145. So slides get the S-curve, for
 * exactly the reason frame-track.ts gives: a linear ramp starts and stops
 * instantly, which reads as the image being shoved rather than moving.
 *
 * The two are also perceptually different problems. A cross-dissolve is a blend,
 * and a blend that eases looks like it is hesitating; a move is a physical
 * gesture, and one that does not ease looks broken.
 */

import { smoothstep } from './frame-track.ts';
import type { FrameBox } from './frame-track.ts';

/**
 * How an overlay arrives and leaves.
 *
 * The slide names say where the image COMES FROM: 'slide-left' enters from off
 * the left edge and leaves back through it. Every transition except 'cut' also
 * carries the opacity ramp — a slide that does not fade pops a hard rectangle
 * onto the frame at full strength, and the two together cost nothing extra.
 *
 * What is deliberately NOT here: a scale/zoom transition. `scale`'s output size
 * is evaluated once at filter-configuration time, exactly like `crop`'s w/h (see
 * the note in frame-track.ts) — so an animated one is not expressible without
 * running the image branch through its own `zoompan`, which is a real feature
 * with its own frame-rate arithmetic rather than another entry in this union.
 */
export type OverlayTransition =
  | 'cut'
  | 'fade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down';

export const OVERLAY_TRANSITIONS: OverlayTransition[] = [
  'cut',
  'fade',
  'slide-left',
  'slide-right',
  'slide-up',
  'slide-down',
];

/**
 * One image, placed over the picture for a stretch of the source.
 *
 * The bytes are NOT here — `assetId` points at a project-level ImageAsset. That
 * split is what lets the same picture appear at four different words without
 * four copies on disk, and it mirrors how the music bed keeps its file on the
 * project rather than on the setting that uses it.
 */
export interface ImageOverlay {
  /** Stable id, so the panel, the monitor and the assistant address one thing. */
  id: string;
  /** Which ImageAsset supplies the pixels. See Project.images. */
  assetId: string;
  /** Source (global) seconds. Half-open [start, end), start < end. */
  start: number;
  end: number;
  transition: OverlayTransition;
  /**
   * Seconds of transition at EACH end, clamped to half the region — so a 0.4s
   * overlay with a 1s ease is a triangle rather than an error. Ignored by 'cut'.
   */
  ease: number;
  /**
   * Where the image sits on the DELIVERED frame, each field a fraction of that
   * frame — the same convention as FrameBox, so a reader who knows the marquee
   * knows this. The default is the whole frame, which is the B-roll cutaway;
   * anything smaller is a picture-in-picture card.
   */
  box: FrameBox;
  /**
   * How the image fills its box.
   *
   * 'cover' crops the overflow, so the box is always completely covered — the
   * right default, because a cutaway with the video showing around its edges
   * reads as a mistake rather than as a frame.
   *
   * 'contain' fits the whole image inside the box and leaves the REST OF THE BOX
   * TRANSPARENT — not black. There is a picture underneath and the honest thing
   * is to let it through; a black pad would be inventing a letterbox the user
   * did not ask for, and one they cannot remove without switching to cover.
   */
  fit: 'cover' | 'contain';
  /** Peak opacity, 0..1. The ramps scale this rather than replacing it. */
  opacity: number;
  /**
   * The word this overlay was dropped on, for the panel to name it by ("on
   * ‘robot’") and for the assistant to reason about.
   *
   * Provenance only — nothing computes from it. start/end stay authoritative
   * because that is what every mapper downstream already speaks, and because a
   * word's timings never change once ASR has set them (see PATCHABLE in doc.ts,
   * which excludes them). A re-transcribe invalidates the id and the times
   * together, so keeping both costs no extra failure mode.
   */
  wordId?: string;
  wordText?: string;
}

/**
 * The shortest overlay worth having, in seconds.
 *
 * This is the same argument `minTrimMs` makes about cuts, pointed at pictures: a
 * cut has to be worth making, and so does an image. A word is ~0.3s long, and an
 * image on screen for 0.3s — a third of which is spent fading in and another
 * third out — is not a cutaway, it is a flash. It reads as a glitch in the
 * render and as a dropped frame on a phone. So targeting a single word does not
 * produce a single word's worth of picture: suggestWindow extends forward from
 * the word instead, and this is the floor it will not go below.
 */
export const MIN_OVERLAY_SEC = 1.2;

/**
 * What an image gets when nobody says otherwise, and the ceiling the assistant's
 * own suggestion is capped at.
 *
 * 2.5s is long enough to look at a picture and short enough that the speaker is
 * still on the same thought. Past ~6s an un-asked-for image stops illustrating
 * the line and starts replacing the video.
 */
export const DEFAULT_OVERLAY_SEC = 2.5;
export const MAX_SUGGESTED_OVERLAY_SEC = 6;

/** Default ramp. Long enough to read as a dissolve, short enough not to be a wait. */
export const DEFAULT_OVERLAY_EASE = 0.35;

/**
 * A ceiling on overlays per project.
 *
 * Every overlay is its own ffmpeg INPUT (a decoder, a scaler) plus its own
 * `overlay` filter in the chain, so unlike words or cuts these do not compress —
 * the graph and the process's memory both grow linearly and visibly. 60 is far
 * past any real edit and well short of where an export becomes a liability.
 */
export const MAX_OVERLAYS = 60;

/** The whole frame: the cutaway, and what a new overlay gets. */
export const FULL_FRAME_BOX: FrameBox = { x: 0, y: 0, width: 1, height: 1 };

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The ease an overlay actually gets: never more than half the region. */
export function easeOf(overlay: Pick<ImageOverlay, 'start' | 'end' | 'ease' | 'transition'>): number {
  if (overlay.transition === 'cut') return 0;
  return clamp(overlay.ease, 0, (overlay.end - overlay.start) / 2);
}

/**
 * The opacity multiplier at time t: 0 outside the region, 1 across the middle, a
 * LINEAR ramp in between. See the header for why linear and not smoothstep.
 *
 * Written as min(rising, falling, 1) rather than as branches, so a region
 * shorter than two ramps degrades to a triangle that peaks below 1 instead of
 * fading in and out over the same frames and double-counting.
 */
export function overlayFade(overlay: ImageOverlay, t: number): number {
  if (t < overlay.start || t >= overlay.end) return 0;
  const ease = easeOf(overlay);
  if (ease <= 0) return 1;
  return clamp(Math.min((t - overlay.start) / ease, (overlay.end - t) / ease, 1), 0, 1);
}

/**
 * How far through its MOVE the overlay is at time t — 0 at each end, 1 across
 * the middle, an S-curve in between.
 *
 * The product of a rising and a falling smoothstep, exactly as moveStrength is,
 * and for the same reason: outside the region one factor is exactly 0, so the
 * expression the render emits needs no branch to be correct there.
 */
export function overlayMotion(overlay: ImageOverlay, t: number): number {
  const ease = easeOf(overlay);
  const rise = smoothstep(overlay.start, overlay.start + ease, t);
  const fall = 1 - smoothstep(overlay.end - ease, overlay.end, t);
  return rise * fall;
}

/**
 * How far off-frame a slide starts, in frame fractions.
 *
 * Measured so the image is COMPLETELY outside the frame at rest — from its own
 * far edge, not from its origin. An image at x=0.6 sliding in from the right has
 * further to travel than one at x=0.1, and travelling a fixed distance instead
 * would leave a sliver of it parked on the frame before the move began.
 */
export function slideTravel(overlay: ImageOverlay): { dx: number; dy: number } {
  const { box } = overlay;
  switch (overlay.transition) {
    case 'slide-left':
      return { dx: -(box.x + box.width), dy: 0 };
    case 'slide-right':
      return { dx: 1 - box.x, dy: 0 };
    case 'slide-up':
      return { dx: 0, dy: -(box.y + box.height) };
    case 'slide-down':
      return { dx: 0, dy: 1 - box.y };
    default:
      return { dx: 0, dy: 0 };
  }
}

/** What an overlay looks like right now. Offsets are fractions of the frame. */
export interface OverlayState {
  opacity: number;
  dx: number;
  dy: number;
}

/**
 * THE function — the monitor calls it 60 times a second and overlayFilterLines
 * is a spelling of it in ffmpeg's expression language. If those two disagree,
 * the app is showing a composite it will not ship.
 *
 * Returns null when the overlay contributes nothing at t, so the preview can
 * skip it and the common case (a playhead nowhere near any image) costs a
 * comparison.
 */
export function sampleOverlay(overlay: ImageOverlay, t: number): OverlayState | null {
  const fade = overlayFade(overlay, t);
  if (fade <= 0) return null;

  const travel = slideTravel(overlay);
  if (travel.dx === 0 && travel.dy === 0) {
    return { opacity: fade * overlay.opacity, dx: 0, dy: 0 };
  }

  // At full motion the image is home; at zero it is off-frame by the whole
  // travel. Same lerp-from-rest as samplePunch, in the other direction.
  const away = 1 - overlayMotion(overlay, t);
  return {
    opacity: fade * overlay.opacity,
    dx: travel.dx * away,
    dy: travel.dy * away,
  };
}

/** Every overlay showing at time t, in draw order (later = on top). */
export function overlaysAt(overlays: ImageOverlay[], t: number): ImageOverlay[] {
  return overlays.filter((o) => t >= o.start && t < o.end);
}

/** True when these overlays would composite nothing — then nothing is emitted. */
export function isEmptyOverlayTrack(overlays: ImageOverlay[]): boolean {
  return overlays.every((o) => o.end - o.start <= 0 || o.opacity <= 0);
}

// ── coercion ──────────────────────────────────────────────────────────────────

/**
 * Coerce anything off the wire or off disk into usable overlays.
 *
 * Same contract as normalizeFrame, normalizeColor and normalizeMoves: per field,
 * not per object, so one bad number does not discard an edit. Then two things
 * those do not all have to do —
 *
 *  - SORT by start, so the panel's list, the preview's scan and the emitter's
 *    chain all read in time order regardless of what the client sent.
 *  - KEEP OVERLAPS, unlike normalizeMoves. Two push-ins at once would sum to a
 *    framing neither asked for; two images at once is a legitimate edit (a
 *    cross-dissolve from one picture to the next is exactly two overlapping
 *    overlays), and the compositor already has an answer for it — later wins,
 *    which is what array order means here and what the filter chain does.
 */
export function normalizeOverlays(input?: unknown): ImageOverlay[] {
  if (!Array.isArray(input)) return [];

  const cleaned: ImageOverlay[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Partial<ImageOverlay>;

    // No asset, no pixels. Unlike every other field this one has no sane
    // fallback, so it is the single reason to drop a record outright.
    const assetId = typeof o.assetId === 'string' && o.assetId ? o.assetId : '';
    if (!assetId) continue;

    const start = Math.max(0, num(o.start, 0));
    const end = Math.max(start, num(o.end, 0));
    if (end - start <= 0) continue;

    const transition = OVERLAY_TRANSITIONS.includes(o.transition as OverlayTransition)
      ? (o.transition as OverlayTransition)
      : 'fade';

    cleaned.push({
      id: typeof o.id === 'string' && o.id ? o.id : `ov${cleaned.length}`,
      assetId,
      start,
      end,
      transition,
      ease: clamp(num(o.ease, DEFAULT_OVERLAY_EASE), 0, (end - start) / 2),
      box: normalizeBox(o.box),
      fit: o.fit === 'contain' ? 'contain' : 'cover',
      opacity: clamp(num(o.opacity, 1), 0, 1),
      // Optional, and they stay optional: writing `wordId: undefined` would stop
      // an untouched overlay round-tripping to an equal object, and the doc's
      // empty-patch test compares these by value.
      ...(typeof o.wordId === 'string' && o.wordId ? { wordId: o.wordId } : {}),
      ...(typeof o.wordText === 'string' && o.wordText ? { wordText: o.wordText } : {}),
    });
  }

  cleaned.sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
  // Bounded here rather than at every caller: this is the one funnel every
  // overlay crosses on its way in from a client or a project file.
  return cleaned.slice(0, MAX_OVERLAYS);
}

/**
 * A placement box off the wire, clamped INTO the frame rather than range-checked.
 *
 * A box is dragged with a pointer that can leave the picture, and the render
 * would happily composite an image whose origin is off-frame — so the clamp is
 * what keeps "where I dropped it" and "where it shows" the same rectangle.
 */
function normalizeBox(input: unknown): FrameBox {
  if (!input || typeof input !== 'object') return { ...FULL_FRAME_BOX };
  const b = input as Partial<FrameBox>;
  const x = clamp(num(b.x, 0), 0, 1);
  const y = clamp(num(b.y, 0), 0, 1);
  const width = clamp(num(b.width, 1), 1e-3, 1 - x);
  const height = clamp(num(b.height, 1), 1e-3, 1 - y);
  return { x, y, width, height };
}

// ── editing ───────────────────────────────────────────────────────────────────

/**
 * How long an image should stay up, given the words it was aimed at.
 *
 * This is the "and for how long" half of the feature, and it is a pure function
 * so the assistant and the Insert button reach the same answer — the assistant
 * does not get its own private heuristic that the UI then contradicts.
 *
 * The rule, in order:
 *  - Start when the first targeted word starts. The picture should arrive AS the
 *    word is said, not after it; arriving late is what makes an insert feel
 *    bolted on rather than motivated.
 *  - Run to the end of the last targeted word, then extend forward to
 *    DEFAULT_OVERLAY_SEC. A one-word target is the common case and one word is
 *    never long enough — see MIN_OVERLAY_SEC.
 *  - Stop at `limit` (the media's end, or wherever the caller says), and never
 *    exceed MAX_SUGGESTED_OVERLAY_SEC.
 *
 * The floor wins over `limit` only when there is genuinely no room left; a
 * caller that gets back less than MIN_OVERLAY_SEC is being told the truth about
 * how much media is left, not handed a window that runs off the end.
 */
export function suggestWindow(
  words: Array<{ start: number; end: number }>,
  limit: number,
  want = DEFAULT_OVERLAY_SEC,
): { start: number; end: number } {
  if (words.length === 0) return { start: 0, end: Math.min(want, limit) };

  const start = Math.max(0, words[0].start);
  const spoken = words[words.length - 1].end;
  const target = Math.max(spoken, start + clamp(want, MIN_OVERLAY_SEC, MAX_SUGGESTED_OVERLAY_SEC));
  return { start, end: Math.min(target, Math.max(start, limit)) };
}

/** A new overlay over [start, end), full-frame and dissolving, until it is moved. */
export function createOverlay(
  id: string,
  assetId: string,
  start: number,
  end: number,
  patch: Partial<ImageOverlay> = {},
): ImageOverlay {
  const from = Math.max(0, start);
  const to = Math.max(from + MIN_OVERLAY_SEC, end);
  return {
    id,
    assetId,
    start: from,
    end: to,
    transition: 'fade',
    ease: Math.min(DEFAULT_OVERLAY_EASE, (to - from) / 2),
    box: { ...FULL_FRAME_BOX },
    fit: 'cover',
    opacity: 1,
    ...patch,
  };
}

/**
 * Add an overlay, refusing once the project is at MAX_OVERLAYS.
 *
 * Returns the ORIGINAL array when it cannot place one, so the caller's no-op
 * test — and therefore the undo stack — needs no special case. Same contract as
 * addMove, which refuses for a different reason.
 */
export function addOverlay(overlays: ImageOverlay[], overlay: ImageOverlay): ImageOverlay[] {
  if (overlays.length >= MAX_OVERLAYS) return overlays;
  return [...overlays, overlay].sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function updateOverlay(
  overlays: ImageOverlay[],
  id: string,
  patch: Partial<ImageOverlay>,
): ImageOverlay[] {
  return overlays
    .map((o) => (o.id === id ? { ...o, ...patch } : o))
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id));
}

export function removeOverlay(overlays: ImageOverlay[], id: string): ImageOverlay[] {
  return overlays.filter((o) => o.id !== id);
}

/** A label for the history entry an overlay change writes. */
export function overlayLabel(overlay: ImageOverlay, verb: string): string {
  const where = overlay.wordText ? `“${overlay.wordText}”` : fmt(overlay.start);
  return `${verb} image at ${where}`;
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// ── the render ────────────────────────────────────────────────────────────────

/**
 * An overlay whose times have been mapped onto the OUTPUT clock, ready to emit.
 *
 * The distinction is the whole reason this type exists rather than reusing
 * ImageOverlay: an ImageOverlay is addressed in source time, and the filter that
 * composites it runs after the cut, where the only clock is the output's.
 */
export type OutputOverlay = ImageOverlay;

/**
 * Move the whole track onto the output clock.
 *
 * `mapTime` is sourceToOutput bound to the EDL — passed in rather than imported
 * so this module keeps knowing nothing about EDLs, exactly as movesToOutput
 * does, and so the caller decides what an unmappable time means.
 *
 * An overlay whose ENDS were cut still shows across whatever survived in the
 * middle: trimming the first second off an insert should shorten it, not delete
 * it. Only an overlay with nothing left is dropped — which is the right answer
 * for the case that matters most, where the user cut the very word the image was
 * illustrating and the image now has nothing to illustrate.
 *
 * The ease is rescaled with the region for the same reason as a move's: a 0.35s
 * dissolve on a region the edit shortened to 0.4s has to shrink or it is the
 * whole overlay.
 */
export function overlaysToOutput(
  overlays: ImageOverlay[],
  mapTime: (t: number) => number | null,
  probe: (from: number, to: number) => number | null = () => null,
): OutputOverlay[] {
  const out: OutputOverlay[] = [];

  for (const overlay of overlays) {
    // A cut end has no output time of its own; walk inwards for the first moment
    // of this overlay that survived.
    const start = mapTime(overlay.start) ?? probe(overlay.start, overlay.end);
    const end = mapTime(overlay.end) ?? probe(overlay.end, overlay.start);
    if (start === null || end === null) continue;
    const [lo, hi] = start <= end ? [start, end] : [end, start];
    if (hi - lo <= 0) continue;

    const kept = (hi - lo) / Math.max(overlay.end - overlay.start, 1e-6);
    out.push({
      ...overlay,
      start: lo,
      end: hi,
      ease: Math.min(easeOf(overlay) * Math.min(kept, 1), (hi - lo) / 2),
    });
  }

  return out.sort((a, b) => a.start - b.start);
}

/** One overlay's file, paired with the placement that will composite it. */
export interface OverlayRenderInput {
  overlay: OutputOverlay;
  /** Absolute path to the image, passed to ffmpeg as its own `-i` input. */
  input: string;
}

export interface OverlayRenderPlan {
  /** Input args for every image, in the order their indices were assigned. */
  inputArgs: string[];
  /** Filtergraph lines, each already terminated with ';'. */
  lines: string[];
  /** The pad carrying the composited picture — the caller's new base. */
  outLabel: string;
}

/**
 * The filtergraph that composites images over the finished picture.
 *
 * Verified end to end against ffmpeg 8.0 before this was written, because two
 * pieces of it are exactly the kind of thing that looks right and is not:
 *
 *  - **The alpha ramp is `fade`, not `colorchannelmixer`.** `aa` is evaluated
 *    once at filter-configuration time, so it can set a constant opacity and
 *    cannot animate one — the same trap `crop`'s w/h sets in frame-track.ts.
 *    `fade` with `alpha=1` is the one that moves. Measured: a red image at the
 *    midpoint of a 0.5s fade-in reads 134/252, i.e. linear.
 *  - **`overlay`'s x/y DO animate**, unlike `crop`'s w/h. Measured: a slide
 *    sampled mid-ramp put the image's left edge at -145px against a predicted
 *    -145, so the smoothstep survives the crossing intact.
 *
 * ── the input shape ──────────────────────────────────────────────────────────
 *
 * `-loop 1 -framerate F -t D -i img` gives a still D seconds of frames at the
 * output's own rate, and `setpts=PTS-STARTPTS+start/TB` slides that window to
 * where it belongs on the output clock. All three parts earn their place:
 *
 *  - `-loop 1` without `-t` is an INFINITE stream, and pairing an infinite
 *    second input with a finite main is how an export hangs.
 *  - `-t D` bounds it to the overlay's own length, so the scaler runs over that
 *    many frames rather than over the whole programme. A 4000px photo rescaled
 *    for every frame of a ten-minute video is minutes of pure waste per image.
 *  - `-framerate F` matters because the image demuxer otherwise emits 25fps, and
 *    a dissolve stepping in 40ms increments under a 60fps picture is visible as
 *    banding rather than as a fade.
 *
 * `eof_action=pass` and `repeatlast=0` are the belt to `enable`'s braces: once
 * the image branch ends, the main picture passes through untouched instead of
 * the compositor holding the last image frame for the rest of the video.
 */
export function overlayFilterLines(
  images: OverlayRenderInput[],
  baseLabel: string,
  out: { width: number; height: number; fps: number },
  firstInputIndex: number,
): OverlayRenderPlan {
  const inputArgs: string[] = [];
  const lines: string[] = [];
  let base = baseLabel;

  // The rate the still is generated at. zoompan aside, this is the only place in
  // the app that has to invent frames, and an unknown rate is a reason to fall
  // back rather than to emit `-framerate 0`.
  const fps = out.fps > 0 ? out.fps : 30;

  images.forEach(({ overlay, input }, i) => {
    const index = firstInputIndex + i;
    const dur = overlay.end - overlay.start;
    const ease = easeOf(overlay);

    // Pixels, from fractions of the delivered frame. Even, because an odd-sized
    // rgba plane fed to a yuv420 compositor is a chroma-siting argument nobody
    // wins — and 2px of rounding is invisible where a failed graph is not.
    const w = even(Math.max(2, Math.round(overlay.box.width * out.width)));
    const h = even(Math.max(2, Math.round(overlay.box.height * out.height)));
    const x0 = Math.round(overlay.box.x * out.width);
    const y0 = Math.round(overlay.box.y * out.height);

    inputArgs.push('-loop', '1', '-framerate', n(fps), '-t', n(dur), '-i', input);

    const branch: string[] = [];
    if (overlay.fit === 'cover') {
      // Fill the box and cut the overflow. crop's w/h are configuration-time,
      // which is fine — this rectangle never moves.
      branch.push(
        `scale=${w}:${h}:force_original_aspect_ratio=increase`,
        `crop=${w}:${h}`,
      );
    } else {
      // Fit the whole image in and leave the remainder of the box TRANSPARENT.
      // black@0, not black: there is a picture underneath, and padding it opaque
      // would invent a letterbox the user never asked for. See ImageOverlay.fit.
      branch.push(
        `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
        `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black@0`,
      );
    }
    branch.push('setsar=1', 'format=rgba');

    // Peak opacity is a constant, so colorchannelmixer is the right tool for it
    // — and it must come BEFORE the fades, which multiply the alpha they are
    // handed. The other order would ramp to full and then flatten to the peak,
    // i.e. the dissolve would end at the wrong level.
    if (overlay.opacity < 1) branch.push(`colorchannelmixer=aa=${n(overlay.opacity)}`);

    // Timed against the branch's OWN clock (it starts at 0 and runs for `dur`),
    // because the setpts that moves it onto the output clock has not happened
    // yet. Zero-length ramps emit nothing: `d=0` is a degenerate fade, and 'cut'
    // asks for exactly that.
    if (ease > 0) {
      branch.push(`fade=t=in:st=0:d=${n(ease)}:alpha=1`);
      branch.push(`fade=t=out:st=${n(dur - ease)}:d=${n(ease)}:alpha=1`);
    }
    branch.push(`setpts=PTS-STARTPTS+${n(overlay.start)}/TB`);

    const img = `[img${i}]`;
    lines.push(`[${index}:v]${branch.join(',')}${img};`);

    const next = `[ov${i}]`;
    lines.push(
      `${base}${img}overlay=x='${posExpr(overlay, 'x', x0, out.width)}':` +
        `y='${posExpr(overlay, 'y', y0, out.height)}':eval=frame:` +
        `eof_action=pass:repeatlast=0:` +
        `enable='between(t,${n(overlay.start)},${n(overlay.end)})'${next};`,
    );
    base = next;
  });

  return { inputArgs, lines, outLabel: base };
}

/**
 * One axis of an overlay's position, in ffmpeg's expression language.
 *
 * A held position is a plain number — no expression, no per-frame evaluation
 * worth the name — so a project full of static inserts emits a graph that reads
 * like the hand-written one. Only a slide grows the S-curve.
 */
function posExpr(overlay: OutputOverlay, axis: 'x' | 'y', origin: number, extent: number): string {
  const travel = slideTravel(overlay);
  const delta = axis === 'x' ? travel.dx : travel.dy;
  if (delta === 0) return n(origin);

  // The same product-of-ramps overlayMotion computes, spelt flat. `1 - motion`
  // because the offset is at its largest when the move has not started.
  const ease = easeOf(overlay);
  const rise = rampExpr(overlay.start, overlay.start + ease);
  const fall = rampExpr(overlay.end - ease, overlay.end);
  const motion = `(${rise})*(1-(${fall}))`;
  return `${n(origin)}+(${n(delta * extent)})*(1-(${motion}))`;
}

/**
 * A smoothstep from `a` to `b`: 0 at or below a, 1 at or above b.
 *
 * Deliberately the same shape as frame-track's rampExpr, including spelling the
 * falling edge as `1 - rise` at the call site rather than running a ramp
 * backwards — a zero-length ease reversed has no direction left to read, and
 * comes out as a gate that switches on at its own end and stays on.
 */
function rampExpr(a: number, b: number): string {
  if (Math.abs(b - a) < 1e-6) return `gte(t,${n(a)})`;
  const u = `clip((t-${n(a)})/(${n(b - a)}),0,1)`;
  return `(${u})*(${u})*(3-2*(${u}))`;
}

/** libx264 needs even dimensions, and so does every yuv420 compositor. */
function even(v: number): number {
  return v % 2 === 0 ? v : v + 1;
}

/**
 * ffmpeg wants plain decimals, never exponential notation — and 4 places is what
 * every other emitter in this codebase rounds to, so a value that crosses into
 * the graph is compared at the same precision on both sides.
 */
function n(value: number): string {
  return value.toFixed(4);
}
