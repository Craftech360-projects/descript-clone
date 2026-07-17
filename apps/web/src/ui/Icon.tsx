import type { ReactNode } from 'react';

/**
 * The icon set.
 *
 * What was here: Unicode glyphs, inline in the markup — ⏮ ◀◀ ❚❚ ▶ ▶▶ ✂ ↶ ↷ ▣ ♪ ✕ ▸.
 * Inter contains none of them. Every one fell through to Segoe UI Symbol, so the
 * transport was assembled from a *different typeface* than the app: different
 * stroke weight, different optical size, different baseline, each glyph scaled by
 * whatever its designer chose rather than by us. ❚❚ is a box-drawing character.
 * ✂ renders as a two-tone emoji on some Windows builds and a hairline outline on
 * others. ▶ is taller than its own line box, so it sat low in a round button.
 *
 * That is why they looked "poorly displayed" — and it is not reachable from CSS.
 * You cannot set the weight of a glyph the font does not have.
 *
 * These are one geometry: a 24px grid, 1.75 stroke, round caps and joins,
 * currentColor throughout. Transport arrows are filled rather than stroked —
 * a hollow play triangle reads as the outline of a button rather than a button.
 *
 * Hand-drawn rather than a dependency: it is ~14 paths, and lucide-react would
 * pull a package tree in to deliver them.
 */

export type IconName =
  | 'play'
  | 'pause'
  | 'skip-start'
  | 'step-back'
  | 'step-forward'
  | 'scissors'
  | 'undo'
  | 'redo'
  | 'plus'
  | 'minus'
  | 'close'
  | 'video'
  | 'audio';

/**
 * Solid, not stroked. At 16px a stroked triangle is mostly hole, and the
 * transport is the one place in the app where the control must out-shout the
 * label next to it.
 */
const FILLED = new Set<IconName>(['play', 'pause', 'skip-start', 'step-back', 'step-forward']);

/* Every filled shape is balanced about x=12 by centroid, not by bounding box:
 * a play triangle centred on its box looks pushed left, which is the classic
 * reason a play button looks subtly broken. */
const PATHS: Record<IconName, ReactNode> = {
  play: <path d="M8 5v14l12-7z" />,
  pause: (
    <>
      <rect x="7.5" y="5" width="3.4" height="14" rx="1.1" />
      <rect x="13.1" y="5" width="3.4" height="14" rx="1.1" />
    </>
  ),
  'skip-start': (
    <>
      <rect x="5.6" y="5" width="2.4" height="14" rx="1" />
      <path d="M18.8 5.4v13.2L9.6 12z" />
    </>
  ),
  'step-back': (
    <>
      <path d="M11.6 5.6v12.8L2.9 12z" />
      <path d="M21.1 5.6v12.8L12.4 12z" />
    </>
  ),
  'step-forward': (
    <>
      <path d="M2.9 5.6v12.8L11.6 12z" />
      <path d="M12.4 5.6v12.8L21.1 12z" />
    </>
  ),
  scissors: (
    <>
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M20 4 8.12 15.88" />
      <path d="M14.47 14.48 20 20" />
      <path d="M8.12 8.12 12 12" />
    </>
  ),
  undo: (
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </>
  ),
  redo: (
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  close: <path d="M18 6 6 18M6 6l12 12" />,
  video: (
    <>
      <path d="m22 8-6 4 6 4V8z" />
      <rect x="2" y="6" width="14" height="12" rx="2" />
    </>
  ),
  audio: (
    <>
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
};

interface Props {
  name: IconName;
  /** Box size in px. The grid is 24, so the stroke scales with it. */
  size?: number;
  className?: string;
}

export default function Icon({ name, size = 16, className }: Props) {
  const filled = FILLED.has(name);
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      /* The button already carries aria-label/title. An icon that announces
       * itself again would read the control twice. */
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
