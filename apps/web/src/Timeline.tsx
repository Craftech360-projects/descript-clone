import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import {
  clampScroll,
  clampZoom,
  MIN_PX_PER_SEC,
  snap,
  sourceMap,
  timecode,
  zoomAt,
} from '../../../packages/core/src/timeline.ts';
import type { Edl } from '../../../packages/core/src/types.ts';
import type { Thumbs } from './api.ts';
import Icon from './ui/Icon.tsx';
import { drawOverlay, drawStatic, fitCanvas, readPalette, type Geometry, type Palette } from './timeline/draw.ts';
import { useFilmstrip } from './timeline/useFilmstrip.ts';

interface Props {
  peaks: number[];
  duration: number;
  edl: Edl | null;
  /** Filmstrip sheets. Absent on audio, or while the job is still building them. */
  thumbs?: Thumbs;
  /** Read imperatively at 60Hz. NOT a prop — see below. */
  getCurrentTime: () => number;
  playing: boolean;
  onSeek: (time: number) => void;
  /** The source range covered by the script selection, for the two to stay in sync. */
  selection: { start: number; end: number } | null;
  /** Word boundaries and cut points — the snap targets. */
  snapTargets: number[];
  onSelectRange: (range: { start: number; end: number } | null) => void;
}

const RULER_H = 22;
const FILM_H = 54;

/**
 * The waveform, with cut material shown as removed.
 *
 * Descript keeps a timeline at the bottom but does not make you live in it — it
 * is for orienting and for precision work, while the script is where you edit.
 * The key thing it must show honestly is WHICH AUDIO SURVIVES: kept ranges are
 * bright, cut ranges are dimmed and struck.
 *
 * currentTime arrives as a getter rather than a prop on purpose. As a prop it
 * would re-render this component — and the whole app — on every animation frame.
 * The playhead lives on its own canvas layer and is drawn from a rAF loop that
 * React never sees.
 */
export default function Timeline({
  peaks,
  duration,
  edl,
  thumbs,
  getCurrentTime,
  playing,
  onSeek,
  selection,
  snapTargets,
  onSelectRange,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  const [size, setSize] = useState({ width: 0, height: 0 });
  const [view, setView] = useState({ pxPerSec: 0, scrollSec: 0 });
  const [hoverTime, setHoverTime] = useState<number | null>(null);

  const paletteRef = useRef<Palette | null>(null);
  const viewRef = useRef(view);
  viewRef.current = view;

  // Suspend follow-during-playback for a moment after a manual scroll. Without
  // this the view fights the user the instant they touch it.
  const manualUntil = useRef(0);

  const film = useFilmstrip(thumbs);
  // No lane at all when there is no picture — an empty 54px band would just be
  // the void the left rail used to be, moved down here.
  const filmH = film ? FILM_H : 0;

  const geo: Geometry = { width: size.width, height: size.height, rulerH: RULER_H, filmH };
  const dpr = window.devicePixelRatio || 1;

  const map = sourceMap(view.pxPerSec, view.scrollSec, duration);

  // The canvas never redrew on resize before — there was no observer at all.
  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new ResizeObserver(([entry]) => {
      const box = entry.contentRect;
      setSize({ width: box.width, height: box.height });
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  // Fit the whole file on first sight of a new media.
  useEffect(() => {
    if (size.width === 0 || duration === 0) return;
    setView({ pxPerSec: MIN_PX_PER_SEC(size.width, duration), scrollSec: 0 });
  }, [duration, size.width === 0]);

  const zoomToFit = useCallback(() => {
    if (size.width === 0 || duration === 0) return;
    setView({ pxPerSec: MIN_PX_PER_SEC(size.width, duration), scrollSec: 0 });
  }, [size.width, duration]);

  // --- static layer: only when the view or the edit actually changes ----------
  useLayoutEffect(() => {
    const canvas = staticRef.current;
    if (!canvas || size.width === 0 || view.pxPerSec === 0) return;
    paletteRef.current = readPalette(canvas);
    const ctx = fitCanvas(canvas, size.width, size.height, dpr);
    drawStatic(ctx, geo, map, peaks, edl, paletteRef.current, dpr, film);
    // `film` changes identity as each sheet decodes, which is what repaints the
    // strip progressively.
  }, [peaks, edl, film, size.width, size.height, view.pxPerSec, view.scrollSec, duration, dpr]);

  // --- overlay: every frame, outside React ------------------------------------
  useEffect(() => {
    const canvas = overlayRef.current;
    if (!canvas || size.width === 0 || view.pxPerSec === 0) return;

    let raf = 0;
    let lastTime = -1;
    let lastSelection = selection;
    let lastHover = hoverTime;

    const frame = () => {
      const time = getCurrentTime();
      const palette = paletteRef.current ?? readPalette(canvas);

      const changed =
        time !== lastTime || lastSelection !== selection || lastHover !== hoverTime;

      if (changed) {
        lastTime = time;
        lastSelection = selection;
        lastHover = hoverTime;
        const ctx = fitCanvas(canvas, size.width, size.height, dpr);
        drawOverlay(ctx, geo, sourceMap(viewRef.current.pxPerSec, viewRef.current.scrollSec, duration), {
          currentTime: time,
          selection,
          hoverTime,
        }, palette, dpr);
      }

      // Page-turn follow, Premiere's default: the waveform stays still until the
      // playhead leaves, rather than sliding under a fixed head.
      if (playing && Date.now() > manualUntil.current) {
        const v = viewRef.current;
        const x = (time - v.scrollSec) * v.pxPerSec;
        if (x > size.width * 0.9 || x < 0) {
          setView((prev) => ({
            ...prev,
            scrollSec: clampScroll(time - size.width * 0.1 / prev.pxPerSec, prev.pxPerSec, size.width, duration),
          }));
        }
      }

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [size.width, size.height, view.pxPerSec, view.scrollSec, duration, dpr, selection, hoverTime, playing, getCurrentTime]);

  // --- interaction ------------------------------------------------------------
  const timeAt = (clientX: number): number => {
    const rect = hostRef.current!.getBoundingClientRect();
    const v = viewRef.current;
    return v.scrollSec + (clientX - rect.left) / v.pxPerSec;
  };

  const onWheel = (e: React.WheelEvent) => {
    if (size.width === 0 || duration === 0) return;

    if (e.ctrlKey || e.metaKey) {
      // Must be non-passive to preventDefault, or the browser page-zooms. See
      // the native listener below.
      return;
    }
    setView((prev) => ({
      ...prev,
      scrollSec: clampScroll(prev.scrollSec + e.deltaY / prev.pxPerSec, prev.pxPerSec, size.width, duration),
    }));
    manualUntil.current = Date.now() + 2000;
  };

  // React attaches wheel passively, so preventDefault there is ignored and the
  // whole page zooms instead. This has to be a native non-passive listener.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || size.width === 0 || duration === 0) return;

    const onNativeWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = host.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;

      setView((prev) => {
        const factor = Math.exp(-e.deltaY * 0.002);
        const next = clampZoom(prev.pxPerSec * factor, size.width, duration);
        const zoomed = zoomAt(prev, mouseX, next);
        return {
          pxPerSec: zoomed.pxPerSec,
          scrollSec: clampScroll(zoomed.scrollSec, zoomed.pxPerSec, size.width, duration),
        };
      });
      manualUntil.current = Date.now() + 2000;
    };

    host.addEventListener('wheel', onNativeWheel, { passive: false });
    return () => host.removeEventListener('wheel', onNativeWheel);
  }, [size.width, duration]);

  const drag = useRef<{ mode: 'scrub' | 'select'; startTime: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (duration === 0) return;
    const rect = hostRef.current!.getBoundingClientRect();
    const onRuler = e.clientY - rect.top < RULER_H;
    const time = clamp(timeAt(e.clientX), 0, duration);

    // Zone-based: the ruler scrubs, the waveform selects. That is Premiere and
    // Audition's split, and it removes the click/drag ambiguity entirely.
    drag.current = { mode: onRuler ? 'scrub' : 'select', startTime: time, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId); // the drag must survive leaving the box
    if (onRuler) onSeek(time);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (duration === 0) return;
    const time = clamp(timeAt(e.clientX), 0, duration);
    setHoverTime(time);

    const d = drag.current;
    if (!d) return;
    if (Math.abs(map.toX(time) - map.toX(d.startTime)) > 3) d.moved = true;

    if (d.mode === 'scrub') {
      onSeek(time);
    } else if (d.moved) {
      const from = snap(Math.min(d.startTime, time), snapTargets, map);
      const to = snap(Math.max(d.startTime, time), snapTargets, map);
      onSelectRange({ start: from, end: to });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    // A click in the waveform seeks; only a drag selects.
    if (d.mode === 'select' && !d.moved) {
      onSeek(d.startTime);
      onSelectRange(null);
    }
  };

  const visible = size.width > 0 && view.pxPerSec > 0 ? size.width / view.pxPerSec : duration;
  const zoomedIn = duration > 0 && visible < duration - 0.01;

  return (
    <div className="tl-wrap">
      <div className="tl-bar">
        <span className="tl-range">
          {timecode(view.scrollSec, { ms: view.pxPerSec > 20 })} –{' '}
          {timecode(Math.min(duration, view.scrollSec + visible), { ms: view.pxPerSec > 20 })}
        </span>
        <div className="tl-zoom">
          <button onClick={() => setView((p) => zoomStep(p, size.width, duration, 1 / 1.5))} title="Zoom out (−)" aria-label="Zoom out">
            <Icon name="minus" size={13} />
          </button>
          <button onClick={() => setView((p) => zoomStep(p, size.width, duration, 1.5))} title="Zoom in (+)" aria-label="Zoom in">
            <Icon name="plus" size={13} />
          </button>
          <button onClick={zoomToFit} disabled={!zoomedIn} title="Zoom to fit (\)">Fit</button>
        </div>
      </div>

      <div
        ref={hostRef}
        className="tl-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => setHoverTime(null)}
      >
        <canvas ref={staticRef} className="tl-layer" />
        <canvas ref={overlayRef} className="tl-layer tl-overlay" />
      </div>
    </div>
  );
}

function zoomStep(
  view: { pxPerSec: number; scrollSec: number },
  width: number,
  duration: number,
  factor: number,
) {
  if (width === 0 || duration === 0) return view;
  // Anchor on the centre, which is what a keyboard zoom should hold still.
  const next = clampZoom(view.pxPerSec * factor, width, duration);
  const zoomed = zoomAt(view, width / 2, next);
  return {
    pxPerSec: zoomed.pxPerSec,
    scrollSec: clampScroll(zoomed.scrollSec, zoomed.pxPerSec, width, duration),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
