import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

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
import { drawClipLane, drawOverlay, drawStatic, fitCanvas, readPalette, type Geometry, type Palette } from './timeline/draw.ts';
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
  /** Clip seams a "+" rides on: `time` in source seconds, `index` the play-order
   *  slot a source dropped there would take. Empty when nothing is open. */
  insertPoints?: { index: number; time: number }[];
  /** A clip op is in flight — the "+" markers freeze while the server rewrites. */
  clipBusy?: boolean;
  onInsertClip?: (file: File, index: number) => void;
  /** Cut the clip under the playhead in two, at the playhead. Absent = no project. */
  onSplit?: () => void;
  /**
   * The background-music bed, drawn as a lane under the waveform. Its extent is
   * in SOURCE seconds (App maps the output-clock bed back), so it shares the same
   * x-mapping as everything else here. Null when no bed is attached.
   */
  music?: { name: string; startSec: number; endSec: number; loop: boolean } | null;
  /** Drag the bed's right edge to trim/extend it — reports the new end, in source
   *  seconds. App turns that into a length on the output clock. */
  onMusicResize?: (endSourceSec: number) => void;
  /** "Duplicate to fill": loop the bed across the whole video. */
  onMusicFill?: () => void;
  /**
   * The clips in play order, for the lane you drag them by. One clip (or none)
   * means nothing to reorder and the lane is not drawn at all.
   */
  clipLane?: { id: string; label: string }[];
  /** Commit a new play order. Called once, on drop, with every id in its new place. */
  onReorderClips?: (ids: string[]) => void;
}

const RULER_H = 22;
const FILM_H = 54;
/** Ceiling on the filmstrip lane, so a vertical source cannot swallow the dock. */
const FILM_MAX_H = 96;
/** The clip lane. Tall enough to grab and read a name in, short enough to stay a strip. */
const CLIP_H = 20;

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
  insertPoints,
  clipBusy,
  onInsertClip,
  onSplit,
  music,
  onMusicResize,
  onMusicFill,
  clipLane,
  onReorderClips,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const staticRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);

  // One hidden input backs every "+"; the marker that opened it leaves the
  // play-order slot to drop into behind, read back on change.
  const fileRef = useRef<HTMLInputElement>(null);
  const pendingIndex = useRef(0);
  const openPicker = (index: number) => {
    pendingIndex.current = index;
    fileRef.current?.click();
  };
  const onInsertFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // same file twice fires no change unless cleared
    if (file) onInsertClip?.(file, pendingIndex.current);
  };

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
  /**
   * The filmstrip lane's height follows the TILE's shape.
   *
   * A fixed 54px band is right for landscape and wrong for the shape this
   * editor now defaults to: a 9:16 tile fitted into 54px is about 30px wide,
   * which reads as a ruler rather than a picture. The server already sizes a
   * portrait tile taller than a landscape one (see planThumbs), so the lane just
   * has to stop capping it — bounded so a very tall source cannot eat the dock.
   */
  const filmH = film
    ? Math.round(Math.min(FILM_MAX_H, Math.max(FILM_H, (FILM_H * film.tileH) / Math.max(1, film.tileW))))
    : 0;

  /**
   * The lane exists only when there is something to reorder. A single-clip
   * project has one block filling the width, which would be a control that
   * cannot do anything — so it gets no lane and no height.
   */
  const laneClips = useMemo(() => {
    if (!clipLane || clipLane.length < 2 || !edl?.clips) return [];
    const byId = new Map(clipLane.map((c) => [c.id, c.label]));
    return edl.clips.map((c) => ({
      id: c.clipId,
      offset: c.offset,
      duration: c.sourceDuration,
      label: byId.get(c.clipId) ?? 'Clip',
    }));
  }, [clipLane, edl]);

  const clipH = laneClips.length >= 2 ? CLIP_H : 0;

  /** Which clip is in hand, and where it would land. Drawn by drawClipLane. */
  const [clipDrag, setClipDrag] = useState<{ id: string; dropIndex: number } | null>(null);
  const [clipHover, setClipHover] = useState<string | null>(null);


  const geo: Geometry = { width: size.width, height: size.height, rulerH: RULER_H, filmH, clipH };
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
    // The clip lane rides on the static layer: it changes when the clips or the
    // drag do, not every frame like the playhead.
    drawClipLane(ctx, geo, map, laneClips, paletteRef.current, dpr, {
      dragId: clipDrag?.id ?? null,
      dropIndex: clipDrag?.dropIndex ?? null,
      hoverId: clipHover,
    });
    // `film` changes identity as each sheet decodes, which is what repaints the
    // strip progressively.
  }, [peaks, edl, film, size.width, size.height, view.pxPerSec, view.scrollSec, duration, dpr, laneClips, clipDrag, clipHover, clipH]);

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
    /**
     * Both axes pan, and the DOMINANT one wins.
     *
     * Only deltaY was read before, which quietly broke the one gesture a Mac
     * user reaches for first: a two-finger horizontal swipe sends deltaX and
     * nothing else, so sliding sideways along the timeline did nothing at all.
     * Taking whichever axis is larger means a horizontal swipe pans, a vertical
     * one still pans (a timeline has no vertical axis to spend it on), and a
     * sloppy diagonal does not count twice and lurch.
     */
    const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    setView((prev) => ({
      ...prev,
      scrollSec: clampScroll(prev.scrollSec + delta / prev.pxPerSec, prev.pxPerSec, size.width, duration),
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

  /**
   * The zoom keys the buttons have always advertised: −, + and \ to fit.
   *
   * Their tooltips named these three from the start and nothing was ever bound
   * to them, so pressing the key the app told you about did nothing — the
   * cheapest possible way to make software feel broken.
   *
   * Bound here rather than in App because the view state lives here. The guards
   * match App's global handler: never while typing, never through a modal.
   */
  useEffect(() => {
    if (size.width === 0 || duration === 0) return;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (document.activeElement?.closest('input,textarea,select,[contenteditable]')) return;
      if (document.querySelector('dialog[open]')) return;

      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        setView((p) => zoomStep(p, size.width, duration, 1 / 1.5));
      } else if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        setView((p) => zoomStep(p, size.width, duration, 1.5));
      } else if (e.key === '\\') {
        e.preventDefault();
        zoomToFit();
      } else {
        return;
      }
      manualUntil.current = Date.now() + 2000;
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [size.width, duration, zoomToFit]);

  const drag = useRef<
    | { mode: 'scrub' | 'select'; startTime: number; moved: boolean }
    | { mode: 'pan'; startX: number; startScroll: number; moved: boolean }
    | { mode: 'clip'; startX: number; moved: boolean }
    | null
  >(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (duration === 0) return;
    const rect = hostRef.current!.getBoundingClientRect();
    const onRuler = e.clientY - rect.top < RULER_H;
    const time = clamp(timeAt(e.clientX), 0, duration);

    /**
     * Drag to PAN — the hand tool, on the middle button or with Alt held.
     *
     * Scrubbing and selecting already own the two zones, so panning needed a
     * gesture of its own rather than a third zone. Middle-drag is what every
     * NLE and every map does; Alt-drag is the same thing for a trackpad, which
     * has no middle button. Neither collides with an existing binding.
     */
    /**
     * The clip lane owns its own band, between the ruler and the filmstrip.
     * Zones rather than modifiers, matching how the ruler scrubs and the
     * waveform selects — a clip is a thing you point at, so pointing at it is
     * how you pick it up.
     */
    const laneTop = RULER_H;
    const inLane = clipH > 0 && e.clientY - rect.top >= laneTop && e.clientY - rect.top < laneTop + clipH;
    if (inLane && !e.altKey && e.button === 0) {
      const held = laneClips.find((c) => time >= c.offset && time < c.offset + c.duration);
      if (held) {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        setClipDrag({ id: held.id, dropIndex: laneClips.findIndex((c) => c.id === held.id) });
        drag.current = { mode: 'clip', startX: e.clientX, moved: false };
        return;
      }
    }

    if (e.button === 1 || e.altKey) {
      e.preventDefault();
      drag.current = { mode: 'pan', startX: e.clientX, startScroll: viewRef.current.scrollSec, moved: false };
      e.currentTarget.setPointerCapture(e.pointerId);
      manualUntil.current = Date.now() + 2000;
      return;
    }

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

    // Which clip the pointer is over, so the lane can light it up and the cursor
    // can say "this is draggable" before you commit to pressing.
    if (clipH > 0 && !drag.current) {
      const rect = hostRef.current!.getBoundingClientRect();
      const dy = e.clientY - rect.top;
      const over =
        dy >= RULER_H && dy < RULER_H + clipH
          ? laneClips.find((c) => time >= c.offset && time < c.offset + c.duration)?.id ?? null
          : null;
      if (over !== clipHover) setClipHover(over);
    }

    const d = drag.current;
    if (!d) return;

    if (d.mode === 'clip') {
      if (Math.abs(e.clientX - d.startX) > 3) d.moved = true;
      /**
       * The slot the clip would take, found by the pointer's position against
       * each block's MIDPOINT — past halfway means it belongs on the far side.
       * That is the standard reorder feel and it makes the last slot reachable,
       * which a "which block am I over" test never does.
       */
      let index = laneClips.length;
      for (let i = 0; i < laneClips.length; i++) {
        const mid = laneClips[i].offset + laneClips[i].duration / 2;
        if (time < mid) { index = i; break; }
      }
      setClipDrag((prev) => (prev && prev.dropIndex !== index ? { ...prev, dropIndex: index } : prev));
      return;
    }

    if (d.mode === 'pan') {
      // Pixels dragged become seconds scrolled, against the drag: the timeline
      // follows the hand, so content moves WITH the pointer the way it does when
      // you push paper across a desk.
      const dx = e.clientX - d.startX;
      if (Math.abs(dx) > 3) d.moved = true;
      setView((prev) => ({
        ...prev,
        scrollSec: clampScroll(d.startScroll - dx / prev.pxPerSec, prev.pxPerSec, size.width, duration),
      }));
      manualUntil.current = Date.now() + 2000;
      return;
    }

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

    if (d.mode === 'clip') {
      const held = clipDrag;
      setClipDrag(null);
      if (!held || !d.moved || !onReorderClips) return;

      const from = laneClips.findIndex((c) => c.id === held.id);
      // Removing the clip first shifts every later slot down by one, so a drop
      // index past the origin has to come back by one to mean the same gap.
      const to = held.dropIndex > from ? held.dropIndex - 1 : held.dropIndex;
      if (from < 0 || to === from) return;

      const ids = laneClips.map((c) => c.id);
      const [moved] = ids.splice(from, 1);
      ids.splice(to, 0, moved);
      onReorderClips(ids);
      return;
    }

    // A click in the waveform seeks; only a drag selects.
    if (d.mode === 'select' && !d.moved) {
      onSeek(d.startTime);
      onSelectRange(null);
    }
  };

  // Dragging the music bed's right edge. Its own pointer capture on the handle,
  // separate from the canvas scrub/select, so the two never fight. Each move maps
  // the pointer to a source time and reports it; App turns that into a length.
  const musicResizing = useRef(false);
  const onMusicHandleDown = (e: React.PointerEvent) => {
    if (!onMusicResize) return;
    e.stopPropagation();
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    musicResizing.current = true;
  };
  const onMusicHandleMove = (e: React.PointerEvent) => {
    if (!musicResizing.current || !music) return;
    const t = clamp(timeAt(e.clientX), music.startSec + 0.05, duration);
    onMusicResize?.(t);
  };
  const onMusicHandleUp = (e: React.PointerEvent) => {
    if (!musicResizing.current) return;
    musicResizing.current = false;
    (e.target as Element).releasePointerCapture(e.pointerId);
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
        <div className="tl-tools">
          {onSplit && (
            <button
              className="tl-split"
              onClick={onSplit}
              disabled={clipBusy || duration === 0}
              title="Split the clip at the playhead (S)"
              aria-label="Split clip at playhead"
            >
              <Icon name="scissors" size={14} />
              Split
            </button>
          )}
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
      </div>

      <div
        ref={hostRef}
        className="tl-canvas"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => { setHoverTime(null); setClipHover(null); }}
        /* The cursor is the affordance: a clip you can pick up says so before
           you press, and says "held" while you drag it. Without this the lane
           looks like more chrome. */
        style={clipDrag ? { cursor: 'grabbing' } : clipHover ? { cursor: 'grab' } : undefined}
      >
        <canvas ref={staticRef} className="tl-layer" />
        <canvas ref={overlayRef} className="tl-layer tl-overlay" />

        {/* The "+" markers ride on the clip seams — the start of each clip, and
          * one past the end. They live in the DOM (not the canvas) so they take a
          * click, and they follow zoom/scroll because `map` is recomputed from
          * `view` on every render. pointerdown stops here so a click on a marker
          * does not also start a scrub/select on the strip beneath it. */}
        {onInsertClip &&
          view.pxPerSec > 0 &&
          (insertPoints ?? []).map((p) => {
            const x = map.toX(p.time);
            if (x < -20 || x > size.width + 20) return null;
            const last = p.index === (insertPoints?.length ?? 1) - 1;
            const where = p.index === 0 ? 'at the start' : last ? 'at the end' : `here`;
            return (
              <button
                key={`${p.index}:${p.time}`}
                className="tl-add"
                style={{ left: clamp(x, 11, Math.max(11, size.width - 11)), top: RULER_H + filmH / 2 }}
                disabled={clipBusy}
                title={`Add a clip ${where}`}
                aria-label={`Add a clip ${where}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => openPicker(p.index)}
              >
                <Icon name="plus" size={18} />
              </button>
            );
          })}
      </div>

      {/* The background-music lane. A track beneath the waveform showing where the
        * bed plays — same x-mapping as the strip above, so it lines up under zoom
        * and scroll. It is editable: drag the right edge to trim or extend, and
        * "Fill" loops the track across the whole video. The bar clamps to the
        * viewport rather than disappearing when one end scrolls off; the edge
        * handle only shows when the real end is on screen. */}
      {music && (() => {
        const rawEnd = map.toX(music.endSec);
        const x0 = Math.max(0, map.toX(music.startSec));
        const x1 = Math.min(size.width, rawEnd);
        const endOnScreen = rawEnd <= size.width + 2;
        return (
          <div className="tl-music" title={`Background music — ${music.name}`}>
            {x1 > x0 && (
              <div
                className={`tl-music-clip${music.loop ? ' looped' : ''}`}
                style={{ left: x0, width: x1 - x0 }}
              >
                <Icon name="audio" size={12} className="tl-music-ico" />
                <span className="tl-music-name">
                  {music.name}
                  {music.loop && <span className="tl-music-badge">loop</span>}
                </span>

                {onMusicFill && (
                  <button
                    className="tl-music-fill"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={onMusicFill}
                    title="Duplicate the track to fill the whole video"
                    aria-label="Loop music to fill the video"
                  >
                    Fill
                  </button>
                )}

                {onMusicResize && endOnScreen && (
                  <span
                    className="tl-music-handle"
                    title="Drag to trim or extend the music"
                    onPointerDown={onMusicHandleDown}
                    onPointerMove={onMusicHandleMove}
                    onPointerUp={onMusicHandleUp}
                  />
                )}
              </div>
            )}
          </div>
        );
      })()}

      <input
        ref={fileRef}
        type="file"
        accept="video/*,audio/*"
        className="tl-add-file"
        onChange={onInsertFile}
      />
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
