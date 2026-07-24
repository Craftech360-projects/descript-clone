/**
 * Output framing: what shape the finished video is, and where the source sits
 * inside it.
 *
 * The problem this solves is that one recording has to become several deliveries
 * — a 16:9 talking head is also a 9:16 reel and a 1:1 square — and the interesting
 * part is never the resolution, it is WHICH PART OF THE PICTURE SURVIVES. Cropping
 * 16:9 to 9:16 throws away 68% of the width, so "centre it" is a guess that is
 * wrong whenever the speaker is not centred. Hence zoom and pan: the crop is a
 * decision the user makes and can see.
 *
 * The model is COVER, not contain. At zoom 1 the source is scaled until it fills
 * the frame with no bars, overflowing on the long axis; zoom scales past that and
 * pan chooses which part of the overflow is kept. Letterboxing is deliberately not
 * offered — a reel with black bars top and bottom is a failed reel, and anyone who
 * wants bars can pick a frame that matches their source.
 */

import { normalizeMoves, type FrameMove } from './frame-track.ts';

export type FramePreset = 'source' | 'reel' | 'youtube' | 'square' | 'custom';

/** The document-level setting: a preset, an explicit size, and the crop. */
export interface FrameSettings {
  preset: FramePreset;
  /**
   * The target size. Meaningful for 'custom'; for the fixed presets it mirrors
   * the preset's own size, and for 'source' it is ignored entirely — the source's
   * dimensions win, and are not known until a project is open.
   */
  width: number;
  height: number;
  /**
   * Scale over the cover fit. 1 exactly fills the frame; 2 shows half the width
   * and half the height; below 1 the picture shrinks inside the frame and the
   * remainder is filled with black.
   *
   * Below 1 is not a degenerate case, it is the point of the lower half of the
   * range: cropping 16:9 to 9:16 at zoom 1 keeps only 32% of the width, and
   * sometimes the shot does not survive that. Zooming out trades bars for the
   * whole picture, which is a real editorial choice and the user's to make. See
   * fitZoom for the exact value that shows all of it.
   */
  zoom: number;
  /**
   * Where the crop sits within the overflow, per axis, as -1..1. 0 is centred,
   * -1 is hard against the left/top edge, +1 against the right/bottom.
   *
   * A FRACTION OF THE OVERFLOW rather than pixels, which is what makes it
   * resolution-independent: the same 0.4 frames the same part of the picture
   * whether the preview is 480px wide or the export is 4K, and it stays valid when
   * the zoom changes underneath it. An axis with no overflow simply ignores it.
   */
  x: number;
  y: number;
  /**
   * Push-ins over the finished frame: mark a portion of the picture and zoom
   * into it for part of the video, optionally following it as it moves.
   *
   * Everything above is ONE value for the whole output. This is the first thing
   * on the document that varies with time, and it deliberately sits here rather
   * than beside it: a move is expressed against the frame this setting delivers,
   * so the two are one decision about what the picture is. See frame-track.ts
   * for the model and for why a move can only ever push IN.
   *
   * Empty is the default and the common case, and every layer treats it as
   * "emit nothing" — so a project that never marks anything renders exactly as
   * it did before this existed.
   */
  moves: FrameMove[];
}

/** A resolved frame: concrete pixels, no preset left to interpret. */
export interface FrameRender {
  width: number;
  height: number;
  zoom: number;
  x: number;
  y: number;
}

export const FRAME_PRESETS = {
  reel: { width: 1080, height: 1920, label: 'Reel', hint: 'TikTok, Reels, Shorts' },
  youtube: { width: 1920, height: 1080, label: 'YouTube', hint: '1080p landscape' },
  square: { width: 1080, height: 1080, label: 'Square', hint: 'Feed posts' },
} as const;

export const DEFAULT_FRAME: FrameSettings = {
  preset: 'source',
  width: 0,
  height: 0,
  zoom: 1,
  x: 0,
  y: 0,
  moves: [],
};

/**
 * Low enough to fit any source into any frame with room to spare. Fitting all of
 * a 16:9 into a 9:16 already needs 0.32, and a wider source into a taller frame
 * needs less still, so this is deliberately below anything fitZoom will return
 * rather than a taste judgement about how small is too small.
 */
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 4;
/** Even, and wide enough that a codec will not reject it. */
export const MIN_DIM = 16;
/** 8K. Past this a browser preview stops being a preview and starts being a swap file. */
export const MAX_DIM = 7680;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/**
 * Round to an even number.
 *
 * yuv420p subsamples chroma 2x2, so an odd dimension has no valid chroma plane
 * and libx264 rejects it outright. Every size this module produces goes through
 * here — a custom 1081 is not an error to report, it is a 1080.
 */
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2);

/** Pan is meaningless outside the overflow it indexes. */
export function clampPan(x: number, y: number): { x: number; y: number } {
  return { x: clamp(x, -1, 1), y: clamp(y, -1, 1) };
}

/**
 * Coerce anything off the wire or off disk into a usable FrameSettings.
 *
 * Same contract as normalizeCaptions: per field, not per object, so a project
 * saved before a field existed picks up the default for that field alone rather
 * than losing the settings it does have.
 */
export function normalizeFrame(input?: Partial<FrameSettings> | null): FrameSettings {
  const f = input ?? {};
  const preset: FramePreset =
    f.preset === 'reel' || f.preset === 'youtube' || f.preset === 'square' || f.preset === 'custom'
      ? f.preset
      : 'source';

  // A fixed preset owns its size; only 'custom' reads the stored numbers, and
  // 'source' has none to read.
  const fixed = preset === 'reel' || preset === 'youtube' || preset === 'square';
  const width = fixed
    ? FRAME_PRESETS[preset].width
    : preset === 'custom'
      ? even(clamp(num(f.width, 1080), MIN_DIM, MAX_DIM))
      : 0;
  const height = fixed
    ? FRAME_PRESETS[preset].height
    : preset === 'custom'
      ? even(clamp(num(f.height, 1080), MIN_DIM, MAX_DIM))
      : 0;

  const { x, y } = clampPan(num(f.x, 0), num(f.y, 0));
  return {
    preset,
    width,
    height,
    zoom: clamp(num(f.zoom, 1), MIN_ZOOM, MAX_ZOOM),
    x,
    y,
    // Sorted, clamped and de-overlapped there rather than here — a move carries
    // its own timeline and its own tracked path, and none of that is this
    // function's business beyond calling the one that owns it.
    moves: normalizeMoves(f.moves),
  };
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** The target size a setting asks for, given the source it is applied to. */
export function frameSize(
  frame: FrameSettings,
  source: { width: number; height: number },
): { width: number; height: number } {
  if (frame.preset === 'source') {
    return { width: even(source.width || 1920), height: even(source.height || 1080) };
  }
  return { width: frame.width, height: frame.height };
}

/**
 * Resolve a setting against a real source, or null if it would change nothing.
 *
 * Null is the important half. Returning a no-op FrameRender would still emit
 * scale and crop filters into the graph — a re-encode of every pixel to produce
 * the same pixels, plus a resampling pass the picture did not need. Callers treat
 * null as "emit nothing", which keeps a project that never opens this panel
 * byte-identical to one from before the feature existed.
 */
export function resolveFrame(
  frame: FrameSettings,
  source: { width: number; height: number },
): FrameRender | null {
  const { width, height } = frameSize(frame, source);
  if (width < MIN_DIM || height < MIN_DIM) return null;

  const sameSize = even(source.width) === width && even(source.height) === height;
  const untouched = Math.abs(frame.zoom - 1) < 1e-6 && frame.x === 0 && frame.y === 0;
  if (sameSize && untouched) return null;

  return { width, height, zoom: frame.zoom, x: frame.x, y: frame.y };
}

/**
 * The filtergraph stages that fit the source into the frame.
 *
 * Written entirely in ffmpeg's own expressions — no source dimensions appear —
 * and that is deliberate. The single-input path would have to probe for them, the
 * multi-clip path may be joining sources that disagree, and a project imported
 * before the frame-rate fix has a stale record of them on disk. Expressions make
 * all three the same code, evaluated against the pixels actually in hand.
 *
 *  - `force_original_aspect_ratio=increase` is the cover fit: it scales until the
 *    image is at least the requested box on BOTH axes, overflowing the other one.
 *    Multiplying that box by zoom is what makes zoom a pure scale — what follows
 *    always resolves the same width×height out of a progressively larger or
 *    smaller image.
 *  - `force_divisible_by=2` on that scale is load-bearing, not hygiene. The cover
 *    fit lands on whatever the source's aspect gives it, and 1920x1080 into a
 *    1080x1920 box comes out 3413 wide — ODD. yuv420p subsamples chroma 2:1, so
 *    pad snaps its width down to the nearest even number, decides 3412 < 3413, and
 *    fails the whole graph with "Padded dimensions cannot be smaller than input
 *    dimensions". crop has no such constraint, which is why this only appeared
 *    once zooming out made pad necessary.
 *  - `pad` THEN `crop`, and the pair is what makes zooming out work. pad can only
 *    grow an image and crop can only shrink it, so neither alone spans a zoom
 *    range that crosses 1. Padding to `max(scaled, frame)` and then cropping to
 *    `frame` is a no-op on whichever side does not apply: zoomed in, the pad sees
 *    ow-iw = 0 and the crop does the work; zoomed out, the pad fills to the frame
 *    and the crop sees iw-ow = 0. One pair, no branch, both directions.
 *  - Both x/y expressions carry the SAME fx, and that is what keeps the pan
 *    continuous through zoom 1. The picture's offset in the finished frame works
 *    out to (frame - scaled) * fx either way — negative while it overflows, so
 *    fx picks which part is kept; positive once it underflows, so fx picks where
 *    it sits among the bars. Neither expression can address a pixel that is not
 *    there, because each spans exactly its own difference.
 *  - `setsar=1` because a source with non-square pixels would otherwise carry its
 *    sample aspect into a frame whose whole point is a known shape.
 */
export function frameFilterStages(frame: FrameRender): string[] {
  const { width, height, zoom } = frame;
  // The cover box, scaled by zoom. Even, because this is a real decoded size and
  // nothing downstream can recover a half pixel.
  const boxW = even(width * zoom);
  const boxH = even(height * zoom);
  // -1..1 -> 0..1, the fraction of the travel taken on the left/top.
  const fx = ((frame.x + 1) / 2).toFixed(4);
  const fy = ((frame.y + 1) / 2).toFixed(4);

  return [
    `scale=${boxW}:${boxH}:force_original_aspect_ratio=increase:force_divisible_by=2`,
    // Commas inside max() are escaped: the filtergraph parser splits on them
    // first, so an unescaped one would end the filter mid-expression.
    `pad=max(iw\\,${width}):max(ih\\,${height}):(ow-iw)*${fx}:(oh-ih)*${fy}:color=black`,
    `crop=${width}:${height}:(iw-ow)*${fx}:(ih-oh)*${fy}`,
    'setsar=1',
  ];
}

/**
 * The zoom at which the whole source is visible inside the frame — "fit", the
 * exact complement of the cover fit that zoom 1 means.
 *
 * cover scales by max(W/sw, H/sh) and contain by min(W/sw, H/sh); zoom multiplies
 * the cover, so the zoom that lands on contain is simply their ratio. Below 1 by
 * construction whenever the shapes differ, and exactly 1 when they match — at
 * which point fit and fill are the same picture and there is nothing to offer.
 */
export function fitZoom(
  source: { width: number; height: number },
  out: { width: number; height: number },
): number {
  if (source.width <= 0 || source.height <= 0 || out.width <= 0 || out.height <= 0) return 1;
  const cover = Math.max(out.width / source.width, out.height / source.height);
  const contain = Math.min(out.width / source.width, out.height / source.height);
  return clamp(contain / cover, MIN_ZOOM, MAX_ZOOM);
}

/**
 * The largest box of `ratio` that fits inside `outer` — the preview's frame.
 *
 * Computed here rather than left to CSS, and that is a bug fix rather than a
 * preference. The CSS spelling of this is `aspect-ratio` with `max-width` and
 * `max-height`, and it does not work when the width is definite: the height is
 * derived from the ratio and then clamped by max-height, but the width is NOT
 * re-derived from the clamped height. The box comes out the full size of its
 * container at every ratio — so a reel, a square and a 16:9 all rendered as the
 * same rectangle, which is exactly the shape of the stage.
 */
export function containBox(
  ratio: { width: number; height: number },
  outer: { width: number; height: number },
): { width: number; height: number } {
  if (ratio.width <= 0 || ratio.height <= 0 || outer.width <= 0 || outer.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(outer.width / ratio.width, outer.height / ratio.height);
  return { width: ratio.width * scale, height: ratio.height * scale };
}

/** Where the source picture sits inside the frame, for the preview. */
export interface FrameLayout {
  /** The picture's rendered size, in the frame box's units. */
  width: number;
  height: number;
  /** Its offset from the frame's top-left. Negative overhangs, positive insets. */
  left: number;
  top: number;
  /**
   * How far the picture can travel on each axis: frame minus picture, SIGNED.
   *
   * Negative while the picture overflows (pan chooses what is kept), positive
   * once it underflows (pan chooses where it sits among the bars). Signed rather
   * than a magnitude because it is the denominator that converts a drag in pixels
   * into a change in pan, and the direction of that conversion genuinely flips at
   * zoom 1 — dragging right reveals what is on the left while overflowing, and
   * simply moves the picture right once it fits. Zero means the axis cannot move.
   */
  travelX: number;
  travelY: number;
}

/**
 * The preview's counterpart to frameFilterStages — the same cover-fit, zoom and
 * pan, expressed as a box instead of a filtergraph.
 *
 * It lives here, beside the filters rather than in the component that uses it,
 * because the two have to agree: if this drifts from what ffmpeg does, the app
 * shows the user a crop it does not ship. Same reason CaptionOverlay reads the
 * same CaptionSettings that toAss does.
 */
export function frameLayout(
  frame: Pick<FrameRender, 'zoom' | 'x' | 'y'>,
  source: { width: number; height: number },
  box: { width: number; height: number },
): FrameLayout {
  if (source.width <= 0 || source.height <= 0 || box.width <= 0 || box.height <= 0) {
    return { width: 0, height: 0, left: 0, top: 0, travelX: 0, travelY: 0 };
  }
  // max, not min: cover. The picture is scaled until it fills BOTH axes, and zoom
  // scales from there — past it to crop, short of it to letterbox.
  const scale = Math.max(box.width / source.width, box.height / source.height) * frame.zoom;
  const width = source.width * scale;
  const height = source.height * scale;
  const travelX = box.width - width;
  const travelY = box.height - height;
  // The same (frame - picture) * fx the filtergraph's pad/crop pair works out to.
  // One formula for both directions is what keeps a pan from jumping as a drag
  // crosses zoom 1.
  return {
    width,
    height,
    left: travelX * ((frame.x + 1) / 2),
    top: travelY * ((frame.y + 1) / 2),
    travelX,
    travelY,
  };
}

/** A label for the history entry a frame change writes. */
export function frameLabel(frame: FrameSettings): string {
  switch (frame.preset) {
    case 'source':
      return 'Use source resolution';
    case 'custom':
      return `Set frame to ${frame.width}x${frame.height}`;
    default:
      return `Set frame to ${FRAME_PRESETS[frame.preset].label}`;
  }
}
