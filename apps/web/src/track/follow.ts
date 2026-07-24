import {
  DEFAULT_TRACK_OPTIONS,
  crop,
  toGray,
  trackStep,
  type Gray,
} from '../../../../packages/core/src/track.ts';
import { centreOn, type FrameBox, type FramePoint } from '../../../../packages/core/src/frame-track.ts';
import type { FrameLayout } from '../../../../packages/core/src/frame.ts';

/**
 * Driving the tracker: the parts that need a browser.
 *
 * The matching itself is in packages/core/src/track.ts, pure and tested without
 * any media. What is here is the half that cannot be — stepping a <video>
 * through a stretch of source, getting each frame's pixels out, and converting
 * between the three coordinate systems this feature has to keep straight.
 *
 * ── the three coordinate systems ─────────────────────────────────────────────
 *
 * A punch is expressed against the DELIVERED FRAME (0..1 of what ships). The
 * pixels come off the SOURCE picture, which the frame is a crop of. And the
 * matcher works in the pixels of a small working CANVAS.
 *
 * Getting these confused is the whole risk in this file, and it does not fail
 * loudly — it produces a follow that tracks something plausible and slightly
 * wrong, which is far worse than one that errors. So the conversions are named,
 * are each other's inverse, and are used in exactly one direction each.
 *
 * ── why it seeks rather than plays ───────────────────────────────────────────
 *
 * Playing the video and grabbing frames as they go is faster and unusable: the
 * browser presents frames on its own schedule, so the samples land at times
 * nobody chose, at a density that depends on how busy the machine is, and the
 * run is not reproducible. Seeking is slow (a seek re-decodes from the previous
 * keyframe — measured 116ms at p50 against this app's own media) but it puts a
 * sample exactly where this code asked for one, which is what makes the path
 * mean something and lets a second run agree with the first.
 */

/** Samples per second of source. */
const SAMPLE_FPS = 8;

/**
 * How wide the matcher's working canvas is, chosen so the template lands near
 * this many pixels across.
 *
 * A template's cost is its own area times the search area, so this is the knob
 * that keeps a follow interactive. ~72px is comfortably enough structure for
 * correlation to be decisive on a face and small enough that a sample costs
 * less than the seek that fetched it.
 */
const TARGET_TEMPLATE_PX = 72;
const MIN_CANVAS_W = 240;
const MAX_CANVAS_W = 960;

export interface FollowRequest {
  video: HTMLVideoElement;
  /** The stretch to follow, in SOURCE (global) seconds. */
  start: number;
  end: number;
  /**
   * Global source time to the element's own currentTime. A single-clip project
   * passes the identity; a sequence passes the active clip's mapping.
   */
  toLocal: (globalTime: number) => number;
  /** What was marked, in frame coordinates. */
  box: FrameBox;
  /**
   * Where the source picture sits inside the frame, as FRACTIONS of the frame —
   * i.e. frameLayout computed against a unit box. Fractions rather than pixels
   * so a follow does not depend on how big the monitor happened to be.
   */
  layout: FrameLayout;
  /** The move's zoom, so a tracked centre can be turned back into a pan. */
  zoom: number;
  signal?: AbortSignal;
  onProgress?: (fraction: number) => void;
}

export interface FollowResult {
  path: FramePoint[];
  /** Samples where the match was not trusted and the last position was held. */
  lost: number;
  /** Total samples taken. `lost` out of this many is how the UI reports quality. */
  samples: number;
}

/** Thrown when the caller aborts. Distinguished so the UI can stay quiet. */
export class FollowAborted extends Error {
  constructor() {
    super('Tracking was cancelled.');
    this.name = 'FollowAborted';
  }
}

/**
 * Follow the marked box across [start, end), returning a path of pan values.
 *
 * The element is left where it started. Tracking is a read of the media, not a
 * navigation, and leaving the playhead parked wherever the last sample happened
 * to be would silently move the user's edit position.
 */
export async function followObject(req: FollowRequest): Promise<FollowResult> {
  const { video, box, layout, zoom } = req;

  const source = { width: video.videoWidth, height: video.videoHeight };
  if (!(source.width > 0 && source.height > 0)) {
    throw new Error('The video has not loaded a picture to track yet.');
  }

  // ── frame coordinates -> source-picture fractions ──────────────────────────
  // The frame is a window onto the picture: the picture spans `layout.width` of
  // the frame starting at `layout.left`, so undoing that is one subtract and one
  // divide. Both are guarded because a degenerate layout would otherwise produce
  // Infinity and a follow that tracks the whole frame.
  if (!(layout.width > 1e-6 && layout.height > 1e-6)) {
    throw new Error('The picture has no size to track in.');
  }
  const frameToPicture = (fx: number, fy: number) => ({
    x: (fx - layout.left) / layout.width,
    y: (fy - layout.top) / layout.height,
  });
  const pictureToFrame = (px: number, py: number) => ({
    x: layout.left + px * layout.width,
    y: layout.top + py * layout.height,
  });

  // The marked box, in fractions of the SOURCE picture.
  const markTL = frameToPicture(box.x, box.y);
  const markSize = { width: box.width / layout.width, height: box.height / layout.height };

  // ── the working canvas ─────────────────────────────────────────────────────
  // Sized so the template lands near TARGET_TEMPLATE_PX across, which is what
  // keeps a sample cheaper than the seek that fetched it.
  const canvasW = Math.round(
    Math.min(MAX_CANVAS_W, Math.max(MIN_CANVAS_W, TARGET_TEMPLATE_PX / Math.max(markSize.width, 1e-3))),
  );
  const canvasH = Math.max(2, Math.round((canvasW * source.height) / source.width));

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  // willReadFrequently, because that is exactly what this does — without it the
  // canvas is GPU-backed and every getImageData is a stall on a readback.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser would not give a 2D canvas to track with.');

  const grab = (): Gray => {
    ctx.drawImage(video, 0, 0, canvasW, canvasH);
    const { data } = ctx.getImageData(0, 0, canvasW, canvasH);
    return toGray(data, canvasW, canvasH);
  };

  const templateRect = {
    x: markTL.x * canvasW,
    y: markTL.y * canvasH,
    width: Math.max(4, markSize.width * canvasW),
    height: Math.max(4, markSize.height * canvasH),
  };

  const wasPaused = video.paused;
  const startedAt = video.currentTime;
  if (!wasPaused) video.pause();

  try {
    // The template is taken at the START of the region, from the frame the user
    // was looking at when they marked it — and never re-taken. See trackStep.
    await seekTo(video, req.toLocal(req.start), req.signal);
    const template = crop(grab(), templateRect);

    const radius = Math.round(Math.min(48, Math.max(16, canvasW * 0.08)));
    const options = { ...DEFAULT_TRACK_OPTIONS, radius };

    const path: FramePoint[] = [];
    let state = { x: Math.round(templateRect.x), y: Math.round(templateRect.y), lost: 0 };
    let lost = 0;

    const step = 1 / SAMPLE_FPS;
    const total = Math.max(1, Math.ceil((req.end - req.start) / step));

    for (let i = 0; i <= total; i++) {
      const t = Math.min(req.end, req.start + i * step);
      await seekTo(video, req.toLocal(t), req.signal);

      const result = trackStep(grab(), template, state, options);
      if (result.held) lost++;
      state = { x: result.x, y: result.y, lost: result.held ? state.lost + 1 : 0 };

      // Canvas pixels -> picture fractions -> frame coordinates -> pan. The
      // centre of the tracked window, not its corner: a punch is centred on what
      // it is following.
      const centre = pictureToFrame(
        (result.x + template.width / 2) / canvasW,
        (result.y + template.height / 2) / canvasH,
      );
      path.push({ t, ...centreOn(centre.x, centre.y, zoom) });

      req.onProgress?.((i + 1) / (total + 1));
      if (t >= req.end) break;
    }

    return { path, lost, samples: path.length };
  } finally {
    // Put the playhead back, whatever happened. Tracking is a read.
    try {
      await seekTo(video, startedAt);
      if (!wasPaused) await video.play().catch(() => {});
    } catch {
      // A failed restore must not mask the real error, or the abort.
    }
  }
}

/**
 * Seek and wait for the picture to actually arrive.
 *
 * `seeked` and not a timeout: assigning currentTime updates the REPORTED
 * position immediately while the decoder is still running up from the previous
 * keyframe, so grabbing pixels on the next tick reliably samples the frame
 * BEFORE the one that was asked for. usePlayback guards the same way for the
 * same reason.
 *
 * The already-there case is checked first, because a seek to the position the
 * element is already at fires no event at all and would hang here forever.
 */
function seekTo(video: HTMLVideoElement, time: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new FollowAborted());

  const target = Math.max(0, time);
  if (!video.seeking && Math.abs(video.currentTime - target) < 1e-3 && video.readyState >= 2) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const done = new AbortController();
    const finish = () => done.abort();

    video.addEventListener('seeked', () => { finish(); resolve(); }, { once: true, signal: done.signal });
    // A seek past a damaged region can fail outright; resolving anyway would
    // score the previous frame twice and read as the subject standing still.
    video.addEventListener('error', () => { finish(); reject(new Error('The video could not be read at that point.')); }, { once: true, signal: done.signal });
    signal?.addEventListener('abort', () => { finish(); reject(new FollowAborted()); }, { once: true, signal: done.signal });

    video.currentTime = target;
  });
}
