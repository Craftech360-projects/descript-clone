import { useCallback, useEffect, useRef, useState } from 'react';

interface Props {
  className: string;
  /** The custom property this splitter drives, e.g. '--w-library'. */
  variable: string;
  min: number;
  max: number;
  initial: number;
  /** Which edge the panel is anchored to: dragging right grows a 'left' panel. */
  side: 'left' | 'right';
}

/**
 * A draggable panel edge.
 *
 * It writes the width straight onto .app as a custom property during the drag
 * rather than going through state, so a resize costs one style write per frame
 * instead of re-rendering the whole app. State is only touched on pointerup, to
 * persist.
 *
 * role="separator" with aria-valuenow and arrow-key support, because a splitter
 * that only responds to a mouse is not a control, it is a decoration.
 */
export default function Splitter({ className, variable, min, max, initial, side }: Props) {
  const [width, setWidth] = useState(() => load(variable, initial, min, max));
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ startX: number; startWidth: number } | null>(null);

  const write = useCallback(
    (value: number) => {
      document.querySelector<HTMLElement>('.app')?.style.setProperty(variable, `${value}px`);
    },
    [variable],
  );

  useEffect(() => { write(width); }, [width, write]);

  const clamp = (v: number) => Math.min(max, Math.max(min, v));

  const onPointerDown = (e: React.PointerEvent) => {
    dragging.current = { startX: e.clientX, startWidth: width };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragging.current;
    if (!d) return;
    const delta = e.clientX - d.startX;
    const next = clamp(d.startWidth + (side === 'left' ? delta : -delta));
    write(next); // straight to CSS — no render
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = dragging.current;
    dragging.current = null;
    if (!d) return;
    e.currentTarget.releasePointerCapture(e.pointerId);
    const delta = e.clientX - d.startX;
    const next = clamp(d.startWidth + (side === 'left' ? delta : -delta));
    setWidth(next);
    save(variable, next);
  };

  const nudge = (delta: number) => {
    const next = clamp(width + delta);
    setWidth(next);
    save(variable, next);
  };

  return (
    <div
      ref={ref}
      className={`splitter ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-label="Resize panel"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onDoubleClick={() => { setWidth(initial); save(variable, initial); }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 50 : 10;
        if (e.key === 'ArrowLeft') { e.preventDefault(); nudge(side === 'left' ? -step : step); }
        if (e.key === 'ArrowRight') { e.preventDefault(); nudge(side === 'left' ? step : -step); }
      }}
    />
  );
}

const key = (variable: string) => `ui.layout${variable}`;

function load(variable: string, fallback: number, min: number, max: number): number {
  const raw = Number(localStorage.getItem(key(variable)));
  return Number.isFinite(raw) && raw >= min && raw <= max ? raw : fallback;
}

function save(variable: string, value: number): void {
  try { localStorage.setItem(key(variable), String(value)); } catch { /* private mode */ }
}
