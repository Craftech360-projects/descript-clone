import { forwardRef, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
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

interface Props {
  project: Project | null;
  /** The clip the monitor is showing. Playback swaps this as the playhead crosses
   *  a seam; for a single-source project it is the one clip. */
  activeClip?: Clip | null;
  result: RenderResult | null;
  onTimeUpdate: () => void;
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
 */
const Monitor = forwardRef<HTMLVideoElement, Props>(function Monitor(
  { project, activeClip, result, onTimeUpdate, onPlay, onPause, overlay, frame, frameRef, onFrameChange, onFrameDragStart, onFrameDragEnd },
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
  // Nothing to pan when the picture exactly fills the frame — which is the
  // default state, so the grab cursor has to be conditional or every project
  // advertises a gesture that does nothing. Magnitude, not sign: an axis is
  // draggable whether the picture overflows it or sits inside it.
  const pannable = Math.abs(layout.travelX) > 0.5 || Math.abs(layout.travelY) > 0.5;

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!pannable) return;
    e.preventDefault();
    dragging.current = { x: e.clientX, y: e.clientY };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    onFrameDragStart();
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
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

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
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

  return (
    <div className="monitor">
      <div className="stage" ref={stageRef}>
        {project && clip ? (
          <div
            ref={frameRef}
            className={`frame${pannable ? ' pannable' : ''}`}
            // Explicit pixels, from containBox. Not aspect-ratio + max-*: with a
            // definite width that clamps the height without re-deriving the
            // width, so every ratio came out the size of the stage.
            style={box.width > 0 ? { width: box.width, height: box.height } : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
          >
            <video
              ref={ref}
              src={clip.sourceUrl}
              onTimeUpdate={onTimeUpdate}
              onPlay={onPlay}
              onPause={onPause}
              style={
                layout.width > 0
                  ? { width: layout.width, height: layout.height, left: layout.left, top: layout.top }
                  : undefined
              }
            />
            {overlay}
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
