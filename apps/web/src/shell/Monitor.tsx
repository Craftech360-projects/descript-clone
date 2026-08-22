import {
  forwardRef,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { clipsOf, type Clip, type Project, type RenderResult } from '../api.ts';
import { renderFilename } from '../download.ts';
import {
  clampPan,
  containBox,
  frameLayout,
  frameSize,
  MAX_ZOOM,
  MIN_ZOOM,
  type FrameSettings,
} from '../../../../packages/core/src/frame.ts';
import { resolveColor, type ColorSettings } from '../../../../packages/core/src/color.ts';
import {
  boxToPunch,
  punchLayout,
  punchToBox,
  samplePunch,
  type FrameBox,
} from '../../../../packages/core/src/frame-track.ts';
import GradeFilter from '../ui/GradeFilter.tsx';

/** One filter definition per document, referenced by the monitor's <video>. */
const MONITOR_GRADE_ID = 'monitor-grade';

interface Props {
  project: Project | null;
  /** The clip the monitor is showing. Playback swaps this as the playhead crosses
   *  a seam; for a single-source project it is the one clip. */
  activeClip?: Clip | null;
  result: RenderResult | null;
  onTimeUpdate: () => void;
  /**
   * The media itself failed to load — a 404, a codec the browser will not take.
   * Without this the monitor was just a black rectangle that ignored Play, which
   * is indistinguishable from a broken app.
   */
  onMediaError?: (message: string) => void;
  onPlay: () => void;
  onPause: () => void;
  /** Drawn over the picture. The monitor stays ignorant of what it is. */
  overlay?: ReactNode;

  /** The output frame. The monitor shows exactly this shape — see below. */
  frame: FrameSettings;
  /** The frame element, so the caption overlay can measure the same rectangle. */
  frameRef: RefObject<HTMLDivElement | null>;
  /** Live during a gesture; the store holds history until the gesture ends. */
  onFrameChange: (frame: FrameSettings) => void;
  onFrameDragStart: () => void;
  onFrameDragEnd: (label: string) => void;

  /** The colour grade. Worn by the picture, not by the frame — see below. */
  color: ColorSettings;

  /**
   * The playhead, in SOURCE (global) seconds, read imperatively.
   *
   * A prop would re-render the whole app 60 times a second, which is the same
   * reason the timeline and the caption overlay take a getter rather than a
   * value. The push-in preview below is the only thing in this component that
   * needs the clock at all.
   */
  getCurrentTime: () => number;
  /**
   * The move currently being marked, if any. While this is set the picture shows
   * the WHOLE frame and a drag draws a box instead of panning — you cannot mark
   * what a push-in has already cropped away.
   */
  markingMoveId: string | null;
  /** A box was dragged over the picture, in frame coordinates. */
  onMark: (moveId: string, box: FrameBox) => void;
  /** Escape, or a click that was not a drag: leave mark mode having changed nothing. */
  onMarkCancel: () => void;
}

/**
 * The program monitor.
 *
 * The script keeps primacy — but primacy comes from the caret, not from area.
 * The script is the only surface with a cursor, the only one that takes keyboard
 * focus, the only one that mutates the document; the monitor is a read-only
 * viewport onto a derived artifact. So it can have real presence without
 * dethroning anything.
 *
 * The layout makes this free: the script has max-width 640px, so past that it
 * cannot use more pixels. Surplus width flows here by construction, and the
 * monitor grows at zero cost to the page.
 *
 * Still no native `controls` — the transport in the dock is the only transport,
 * and it survives the monitor being hidden.
 *
 * ── the frame ────────────────────────────────────────────────────────────────
 *
 * The monitor is not a window onto the source, it is a window onto the OUTPUT.
 * `.frame` carries the target aspect and clips; the <video> is absolutely
 * positioned inside it at the size and offset frameLayout computes — the same
 * cover/zoom/pan the render's scale+crop performs. So a 9:16 reel is previewed
 * as a 9:16 reel with the sides really gone, rather than as a 16:9 with a
 * rectangle drawn on it.
 *
 * This is also why object-fit is gone. `contain` letterboxes to preserve the
 * SOURCE's aspect, which is precisely the thing being overridden here; the
 * explicit width/height/left/top are the crop. At the default 'source' frame the
 * layout resolves to the source's own aspect with zero overflow, so the monitor
 * looks exactly as it did before this existed.
 *
 * ── the grade ────────────────────────────────────────────────────────────────
 *
 * An SVG filter on the <video> element, built from the same resolveColor the
 * render resolves — see GradeFilter. It is on the PICTURE and nowhere else, and
 * that placement is the preview's half of a contract: the render grades before it
 * burns captions, so here the caption layer has to sit outside the filter or the
 * monitor would tint text the file leaves white.
 *
 * ── the push-in ──────────────────────────────────────────────────────────────
 *
 * A marked push-in animates, so it is the one thing here that cannot be a React
 * prop: it changes every frame, and re-rendering the app at 60Hz to move a crop
 * is exactly what the rest of this codebase refuses to do. So the effect below
 * runs on rAF and writes the <video>'s geometry IMPERATIVELY, from the same
 * samplePunch the render's zoompan expression is a spelling of.
 *
 * It writes the same four properties React writes, which is safe because React
 * only writes them when something real changed and the next animation frame
 * restores the animated value. The loop mounts only when the document has a move
 * at all, so a project that never marks anything runs no loop.
 *
 * The caption layer is deliberately NOT punched: captions belong to the
 * delivered frame and stay put and legible while the picture moves under them,
 * which is exactly where the render puts the burn — after the zoompan.
 */
const Monitor = forwardRef<HTMLVideoElement, Props>(function Monitor(
  { project, activeClip, result, onTimeUpdate, onMediaError, onPlay, onPause, overlay, frame, frameRef, onFrameChange, onFrameDragStart, onFrameDragEnd, color, getCurrentTime, markingMoveId, onMark, onMarkCancel },
  ref,
) {
  // The clip the monitor is showing. Playback drives it by playhead via
  // `activeClip`; falling back to the first clip covers the initial render before
  // the active clip is set and the single-source case.
  const clip = activeClip ?? (project ? clipsOf(project)[0] : null);

  // The STAGE's pixel size. The frame is then sized from it in JS rather than by
  // CSS — see containBox for why aspect-ratio cannot do this job here.
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const dragging = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      setStage({ width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const source = {
    width: clip?.width ?? project?.width ?? 0,
    height: clip?.height ?? project?.height ?? 0,
  };
  const out = project ? frameSize(frame, source) : { width: 0, height: 0 };
  // The frame's real on-screen box: the output's shape, fitted into the stage.
  const box = containBox(out, stage);
  const layout = frameLayout(frame, source, box);
  // null when the grade is neutral — and then no filter is referenced at all, so
  // the browser composites the video exactly as it did before grading existed.
  // Same null, from the same function, that keeps the render's graph unchanged.
  const grade = useMemo(() => resolveColor(color), [color]);
  // Nothing to pan when the picture exactly fills the frame — which is the
  // default state, so the grab cursor has to be conditional or every project
  // advertises a gesture that does nothing. Magnitude, not sign: an axis is
  // draggable whether the picture overflows it or sits inside it.
  const pannable = Math.abs(layout.travelX) > 0.5 || Math.abs(layout.travelY) > 0.5;

  // ── marking ────────────────────────────────────────────────────────────────
  //
  // The marquee is React state and not a ref, unlike the pan: it has to be
  // PAINTED as it is dragged, and a rectangle drawn once per pointermove is a
  // handful of renders per gesture rather than the sixty per second the punch
  // preview would cost. This is the same distinction the caption overlay draws
  // between its cue index (state) and its clock (rAF).
  const [marquee, setMarquee] = useState<FrameBox | null>(null);
  const markAnchor = useRef<{ x: number; y: number } | null>(null);

  /** A pointer event, as a fraction of the frame box. */
  const atFrame = (e: React.PointerEvent<HTMLDivElement>) => {
    const el = frameRef.current;
    if (!el) return { x: 0, y: 0 };
    const r = el.getBoundingClientRect();
    return {
      x: r.width > 0 ? Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) : 0,
      y: r.height > 0 ? Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) : 0,
    };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (markingMoveId) {
      e.preventDefault();
      markAnchor.current = atFrame(e);
      setMarquee({ ...markAnchor.current, width: 0, height: 0 });
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      return;
    }
    if (!pannable) return;
    e.preventDefault();
    dragging.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onFrameDragStart();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const anchor = markAnchor.current;
    if (anchor) {
      const to = atFrame(e);
      // Normalised, so a box dragged up-and-left is the same box as one dragged
      // down-and-right rather than a negative rectangle nothing can render.
      setMarquee({
        x: Math.min(anchor.x, to.x),
        y: Math.min(anchor.y, to.y),
        width: Math.abs(to.x - anchor.x),
        height: Math.abs(to.y - anchor.y),
      });
      return;
    }

    const from = dragging.current;
    if (!from) return;
    const dx = e.clientX - from.x;
    const dy = e.clientY - from.y;
    dragging.current = { x: e.clientX, y: e.clientY };

    // Pixels -> pan. The travel spans the full -1..1, so a drag across it moves
    // pan by 2; dividing by it makes the picture track the pointer exactly.
    //
    // The travel is SIGNED and that is what carries the gesture through zoom 1
    // without a branch: while the picture overflows it is negative, so dragging
    // right lowers x and reveals the left; once the picture fits inside the frame
    // it is positive, so the same drag raises x and slides the picture right.
    // Both are "the picture follows the pointer". An axis with zero travel
    // contributes nothing rather than dividing by zero.
    const nx = layout.travelX !== 0 ? frame.x + (dx * 2) / layout.travelX : frame.x;
    const ny = layout.travelY !== 0 ? frame.y + (dy * 2) / layout.travelY : frame.y;
    const { x, y } = clampPan(nx, ny);
    if (x !== frame.x || y !== frame.y) onFrameChange({ ...frame, x, y });
  };

  /**
   * The smallest marquee that counts as a mark, as a fraction of the frame.
   *
   * Below this it was a click, not a drag — and a 2% box would resolve to a 50x
   * push-in that the zoom clamp turns into "as far in as possible, somewhere
   * near there", which looks exactly like a bug. A stray click leaves mark mode
   * having changed nothing, which is what a stray click should do.
   */
  const MIN_MARK = 0.04;

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (markAnchor.current) {
      const box = marquee;
      markAnchor.current = null;
      setMarquee(null);
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      if (box && box.width >= MIN_MARK && box.height >= MIN_MARK && markingMoveId) {
        onMark(markingMoveId, box);
      } else {
        onMarkCancel();
      }
      return;
    }
    if (!dragging.current) return;
    dragging.current = null;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    onFrameDragEnd('Move frame');
  };

  // Wheel zooms about the frame's centre. Passive listeners cannot preventDefault
  // and React's onWheel is passive, so this is attached by hand — without it the
  // page scrolls out from under the gesture.
  const onWheel = useCallback(
    (e: WheelEvent) => {
      if (!project?.hasVideo) return;
      e.preventDefault();
      // A trackpad reports far smaller deltas than a mouse notch; the sign is what
      // matters, and a fixed step keeps both feeling the same.
      //
      // Multiplicative, not additive: the range now spans 0.1 to 4, and a fixed
      // +0.1 that is a 10% nudge at the top is a doubling at the bottom. A
      // constant ratio makes one notch feel like the same amount of zoom
      // everywhere in the range.
      const factor = e.deltaY > 0 ? 1 / 1.1 : 1.1;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(frame.zoom * factor * 100) / 100));
      if (zoom === frame.zoom) return;
      onFrameDragStart();
      onFrameChange({ ...frame, zoom });
      onFrameDragEnd('Zoom frame');
    },
    [frame, onFrameChange, onFrameDragStart, onFrameDragEnd, project?.hasVideo],
  );

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [frameRef, onWheel]);

  // ── the live push-in ───────────────────────────────────────────────────────
  //
  // Mounted only when there is a move to animate, so the common project pays
  // nothing. While marking it stays off entirely and the picture shows the whole
  // frame: you cannot mark an object a push-in has already cropped out of shot.
  const moves = frame.moves;
  const videoRef = ref as RefObject<HTMLVideoElement | null>;

  // The geometry the loop reads, through a ref rather than through the effect's
  // dependencies. `layout` and `box` are fresh objects on every render, so
  // depending on them would tear the loop down and rebuild it on every render —
  // and App re-renders ~4Hz during playback (the karaoke clock). Each teardown
  // restores the UN-punched geometry, so the picture would snap out of the
  // push-in for a frame, four times a second, for the whole move.
  const geometry = useRef({ layout, box });
  geometry.current = { layout, box };

  const punching = moves.length > 0 && !markingMoveId;
  useEffect(() => {
    const video = videoRef?.current;
    if (!video || !punching) return;

    let raf = 0;
    // Written only when they change. Assigning identical strings to a style
    // property is cheap but not free, and this runs 60 times a second for the
    // whole time a project has a move in it — most of which is spent at rest
    // between moves, where every frame's answer is the same one.
    //
    // The BASE is part of the key, not just the punched result, and that is what
    // makes the cache safe rather than merely fast. React writes these same four
    // properties whenever the base layout really changes — a window resize, a new
    // preset — and it writes the UN-punched values. Keyed on the punch alone the
    // cache would then report a hit against a style React had just overwritten,
    // and the picture would sit un-punched until the move's value happened to
    // move. React does not rewrite unchanged styles, so an unrelated re-render
    // still costs nothing.
    let last = '';

    const paint = () => {
      raf = requestAnimationFrame(paint);
      const { layout: base, box: frameBox } = geometry.current;
      if (frameBox.width <= 0) return;

      const punched = punchLayout(base, samplePunch(moves, getCurrentTime()), frameBox);
      const key =
        `${base.width}|${base.left}|${base.top}|` +
        `${punched.width}|${punched.height}|${punched.left}|${punched.top}`;
      if (key === last) return;
      last = key;
      video.style.width = `${punched.width}px`;
      video.style.height = `${punched.height}px`;
      video.style.left = `${punched.left}px`;
      video.style.top = `${punched.top}px`;
    };

    raf = requestAnimationFrame(paint);
    return () => {
      cancelAnimationFrame(raf);
      // Hand the element back to React in the state React thinks it is in.
      // Without this, entering mark mode (or deleting the last move) would strand
      // the picture at whatever the final animated frame happened to be.
      const base = geometry.current.layout;
      if (base.width > 0) {
        video.style.width = `${base.width}px`;
        video.style.height = `${base.height}px`;
        video.style.left = `${base.left}px`;
        video.style.top = `${base.top}px`;
      }
    };
  }, [videoRef, moves, punching, getCurrentTime]);

  // Escape leaves mark mode. A modal gesture with no way out but completing it
  // is a trap, and the marquee is the only modal thing in this app.
  useEffect(() => {
    if (!markingMoveId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      /**
       * Stop here. App has its own window-level Escape that clears the script
       * selection, and preventDefault does not stop a sibling listener — so
       * cancelling a marquee ALSO dropped the selection, swapping the rail away
       * from the very words the push-in was aimed at.
       */
      e.stopImmediatePropagation();
      markAnchor.current = null;
      setMarquee(null);
      onMarkCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [markingMoveId, onMarkCancel]);

  // What the marquee would deliver, shown live: the box the user is dragging is
  // not quite the shot they get — a punch preserves the frame's aspect, so it
  // CONTAINS the mark and takes more of the other axis. Drawing both is the only
  // honest way to say that before they let go.
  const wouldPunch = marquee && marquee.width > 0 ? punchToBox(boxToPunch(marquee)) : null;

  return (
    <div className="monitor">
      <div className="stage" ref={stageRef}>
        {project && clip ? (
          <div
            ref={frameRef}
            className={`frame${pannable && !markingMoveId ? ' pannable' : ''}${markingMoveId ? ' marking' : ''}`}
            // Explicit pixels, from containBox. Not aspect-ratio + max-*: with a
            // definite width that clamps the height without re-deriving the
            // width, so every ratio came out the size of the stage.
            style={box.width > 0 ? { width: box.width, height: box.height } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <GradeFilter id={MONITOR_GRADE_ID} grade={grade} />
            <video
              ref={ref}
              src={clip.sourceUrl}
              onTimeUpdate={onTimeUpdate}
              onPlay={onPlay}
              onPause={onPause}
              // A missing or unplayable file is silent otherwise: the element
              // simply never paints and never fires timeupdate.
              onError={() =>
                onMediaError?.(
                  `This project's media could not be loaded (${clip.sourceUrl}). ` +
                    'The file may have been moved or deleted.',
                )
              }
              style={{
                ...(layout.width > 0
                  ? { width: layout.width, height: layout.height, left: layout.left, top: layout.top }
                  : {}),
                // No `filter` key at all when the grade is neutral, rather than
                // `filter: none`: a filter property of any value promotes the
                // element to its own compositing layer, and a project that never
                // opens the panel should not pay for one.
                ...(grade ? { filter: `url(#${MONITOR_GRADE_ID})` } : {}),
              }}
            />
            {overlay}

            {/* The marquee, and the shot it would actually deliver. Outside the
              * grade filter and outside the punch — this is chrome drawn ON the
              * frame, not part of the picture. */}
            {markingMoveId && (
              <div className="mark-layer">
                {marquee && marquee.width > 0 && (
                  <div
                    className="mark-box"
                    style={{
                      left: `${marquee.x * 100}%`,
                      top: `${marquee.y * 100}%`,
                      width: `${marquee.width * 100}%`,
                      height: `${marquee.height * 100}%`,
                    }}
                  />
                )}
                {wouldPunch && (
                  <div
                    className="mark-shot"
                    style={{
                      left: `${wouldPunch.x * 100}%`,
                      top: `${wouldPunch.y * 100}%`,
                      width: `${wouldPunch.width * 100}%`,
                      height: `${wouldPunch.height * 100}%`,
                    }}
                  />
                )}
                {!marquee && (
                  <p className="mark-hint">
                    Drag a box around what to follow
                    <small>Esc to cancel</small>
                  </p>
                )}
              </div>
            )}
          </div>
        ) : (
          <div className="stage-empty">
            <span>No media</span>
          </div>
        )}
      </div>

      <div className="stage-meta">
        {project && (
          <span className="dims">
            {project.hasVideo ? outputDims(project, out) : 'Audio only'}
            {project.fps ? ` · ${formatFps(project.fps)}` : ''}
          </span>
        )}
        {/* The save already happened when the render finished. This is here for
          * the second copy, or for a cancelled Save dialog. */}
        {project && result && (
          <a href={result.url} download={renderFilename(project, result)} className="dl">
            Save render again
          </a>
        )}
      </div>
    </div>
  );
});

/**
 * The size line under the picture.
 *
 * Shows the source alone while they agree, and "source → output" once reframing
 * changes it — the output is what the file will be, but the source is what the
 * user recognises, and dropping it would make the panel look like it had
 * misread the media.
 */
function outputDims(project: Project, out: { width: number; height: number }): string {
  const src = `${project.width}×${project.height}`;
  const dst = `${out.width}×${out.height}`;
  return src === dst ? src : `${src} → ${dst}`;
}

/** 59.94, not 59.940000000000005. */
function formatFps(fps: number): string {
  const rounded = Math.round(fps * 100) / 100;
  return `${rounded} fps`;
}

export default Monitor;
