/**
 * Following a marked object through a video, by template matching.
 *
 * The verb the user asked for is "mark this and follow it", and the honest ways
 * to do that are a trained detector or a correlation tracker. A detector means a
 * model — this machine has no usable GPU (config.ts says so, which is why
 * transcription is remote), so it would mean another remote service, another key
 * and another thing to be offline. A correlation tracker is arithmetic over
 * pixels the browser has already decoded, and for the shot this feature is FOR —
 * a person talking, moving a few percent of the frame per second — it is the
 * right tool rather than the cheap one.
 *
 * So: no dependency, no model, no service, and it runs on frames the preview
 * already has. What it cannot do is stated in `trackStep` and surfaced in the UI
 * rather than hidden.
 *
 * ── why NCC and not sum-of-absolute-differences ──────────────────────────────
 *
 * SAD is faster and wrong for this. It scores absolute brightness, so the moment
 * the subject moves through a change of light — which is most of what happens
 * when someone turns their head — every candidate window gets worse together and
 * the best one stops meaning anything. Normalised cross-correlation subtracts
 * each window's own mean and divides by its own deviation, so it scores SHAPE:
 * the same face half a stop darker still correlates at ~1, and a flat patch of
 * wall correlates with nothing. That normalisation is also what makes the score
 * comparable BETWEEN frames, which is what lets `minScore` mean something and
 * lets the tracker say "I lost it" instead of drifting confidently onto a wall.
 *
 * Everything here is plain arrays and numbers so it stays zero-dependency and
 * testable under `node --test` — the browser half (decoding frames, seeking the
 * element) lives in the app, where it belongs.
 */

/** A single-channel image. `data` is row-major, `data[y * width + x]`. */
export interface Gray {
  data: Float32Array;
  width: number;
  height: number;
}

/** A rectangle in pixels, within a Gray. */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Rec.709 luma, the same coefficients color.ts grades against.
 *
 * Stated rather than borrowed for the same reason as there: "brightness" has
 * several definitions and picking one here means the tracker is not silently
 * scoring a different quantity from the one the rest of the app talks about.
 */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** RGBA bytes — a canvas's getImageData — as luma in 0..1. */
export function toGray(rgba: Uint8ClampedArray, width: number, height: number): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i++, p += 4) {
    data[i] = (LUMA.r * rgba[p] + LUMA.g * rgba[p + 1] + LUMA.b * rgba[p + 2]) / 255;
  }
  return { data, width, height };
}

/** Lift a rectangle out as its own image — the template to hunt for. */
export function crop(image: Gray, rect: Rect): Gray {
  const x0 = Math.max(0, Math.round(rect.x));
  const y0 = Math.max(0, Math.round(rect.y));
  const w = Math.max(1, Math.min(Math.round(rect.width), image.width - x0));
  const h = Math.max(1, Math.min(Math.round(rect.height), image.height - y0));

  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const src = (y0 + y) * image.width + x0;
    data.set(image.data.subarray(src, src + w), y * w);
  }
  return { data, width: w, height: h };
}

/** Mean and standard deviation, precomputed once for the template. */
interface Stats {
  mean: number;
  /** The L2 norm of the mean-subtracted patch — NCC's denominator. */
  norm: number;
}

function statsOf(data: Float32Array | Float64Array): Stats {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;

  let sq = 0;
  for (let i = 0; i < data.length; i++) {
    const d = data[i] - mean;
    sq += d * d;
  }
  return { mean, norm: Math.sqrt(sq) };
}

export interface Match {
  /** Top-left of the best window, in the searched image's pixels. */
  x: number;
  y: number;
  /**
   * -1..1. 1 is an exact match of shape; 0 is no relationship at all.
   *
   * Judge a follow by this and not by distance moved: a tracker that has lost
   * the subject usually reports a small, confident-looking jump.
   */
  score: number;
}

/**
 * Find `template` in `image`, searching only around `near`.
 *
 * Local, not global, and that is a correctness choice as much as a speed one. A
 * whole-frame search finds the best-correlating patch anywhere, which for a face
 * in a two-shot is regularly the OTHER face — the tracker would hop between them
 * and both jumps would score beautifully. Searching a neighbourhood encodes the
 * one thing actually known about the subject between two samples 150ms apart: it
 * did not teleport.
 *
 * `radius` is therefore a statement about speed, in pixels per sample, and the
 * caller sets it from the sample interval.
 */
export function matchTemplate(
  image: Gray,
  template: Gray,
  near: { x: number; y: number },
  radius: number,
): Match {
  const tw = template.width;
  const th = template.height;
  const stats = statsOf(template.data);

  // A featureless template — a patch of sky, an out-of-focus wall — correlates
  // with everything equally, so there is no "best" to find and any answer would
  // be noise dressed as a measurement. Say so instead.
  if (stats.norm < 1e-6) return { x: near.x, y: near.y, score: 0 };

  const minX = Math.max(0, Math.round(near.x - radius));
  const maxX = Math.min(image.width - tw, Math.round(near.x + radius));
  const minY = Math.max(0, Math.round(near.y - radius));
  const maxY = Math.min(image.height - th, Math.round(near.y + radius));

  let best: Match = { x: near.x, y: near.y, score: -1 };

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const score = ncc(image, template, stats, x, y);
      if (score > best.score) best = { x, y, score };
    }
  }

  // No candidate fitted inside the image at all (a template larger than the
  // frame, or a `near` right against an edge with no room). Hold position.
  return best.score < -0.5 ? { x: near.x, y: near.y, score: 0 } : best;
}

/**
 * Normalised cross-correlation of `template` against the window of `image` whose
 * top-left is (ox, oy).
 *
 * One pass, accumulating the window's own sum and sum-of-squares alongside the
 * cross term, so its mean and norm come out of the same traversal rather than
 * costing a second one. Written out rather than expressed as three helper calls
 * because this is the inner loop — it runs (2r+1)² times per sample.
 */
function ncc(image: Gray, template: Gray, t: Stats, ox: number, oy: number): number {
  const tw = template.width;
  const th = template.height;
  const n = tw * th;

  let sum = 0;
  let sumSq = 0;
  let cross = 0;

  for (let y = 0; y < th; y++) {
    let ii = (oy + y) * image.width + ox;
    let ti = y * tw;
    for (let x = 0; x < tw; x++, ii++, ti++) {
      const v = image.data[ii];
      sum += v;
      sumSq += v * v;
      cross += v * template.data[ti];
    }
  }

  const mean = sum / n;
  // Σ(v-v̄)² expanded, so the window needs no second pass to subtract its mean.
  const varSum = sumSq - mean * sum;
  if (varSum <= 1e-12) return 0; // a flat window matches nothing in particular
  // Σ(v-v̄)(t-t̄) likewise: the template's mean times the window's sum is the
  // only cross-term that survives, because Σ(v-v̄) is zero by construction.
  return (cross - t.mean * sum) / (Math.sqrt(varSum) * t.norm);
}

/** What a follow is allowed to do between two samples. */
export interface TrackOptions {
  /**
   * How far the subject may travel between samples, in pixels of the searched
   * image. Larger costs (2r+1)² per sample and admits more chances to lock onto
   * the wrong thing.
   */
  radius: number;
  /**
   * Below this correlation the answer is not trusted and the previous position
   * is held.
   *
   * 0.5 rather than something stricter because a real subject turning its head
   * drops into the 0.5-0.7 range routinely, and a tracker that gives up there is
   * a tracker that gives up. Below 0.5 the window has more in common with the
   * background than with what was marked.
   */
  minScore: number;
}

export const DEFAULT_TRACK_OPTIONS: TrackOptions = { radius: 24, minScore: 0.5 };

export interface TrackState {
  /** Where the subject was last seen, top-left, in the searched image. */
  x: number;
  y: number;
  /** Consecutive samples whose match was not trusted. */
  lost: number;
}

export interface TrackStep {
  x: number;
  y: number;
  score: number;
  /** True when the match was rejected and the previous position was held. */
  held: boolean;
}

/**
 * One step of a follow: where the marked thing is now.
 *
 * The template is the one taken when the object was MARKED, and it is never
 * updated. Re-taking it each step is the obvious way to survive a subject that
 * changes appearance, and it is also how a tracker walks off its subject: every
 * step's small error is baked into the thing the next step hunts for, so the
 * template creeps onto whatever is beside the target and then follows THAT with
 * total confidence. A fixed template cannot drift. What it can do instead is
 * lose the subject honestly, which is what `held` reports and what the caller
 * turns into something the user can see.
 */
export function trackStep(
  image: Gray,
  template: Gray,
  state: TrackState,
  options: TrackOptions = DEFAULT_TRACK_OPTIONS,
): TrackStep {
  const match = matchTemplate(image, template, state, options.radius);
  const held = match.score < options.minScore;
  return held
    ? { x: state.x, y: state.y, score: match.score, held: true }
    : { x: match.x, y: match.y, score: match.score, held: false };
}
