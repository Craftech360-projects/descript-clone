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
  | 'menu'
  | 'grid'
  | 'pencil'
  | 'trash'
  | 'video'
  | 'audio'
  /* The rail's section marks. A row of seven settings is scanned by SHAPE
   * before it is read — that is the whole reason these exist. */
  | 'clock'
  | 'crop'
  | 'sparkle'
  | 'music'
  | 'captions'
  | 'sliders';

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
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  /* Four cards, not nine: this points at the project grid, and the grid's cells
   * are wide. Nine equal squares would read as a keypad. */
  grid: (
    <>
      <rect x="3.5" y="3.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="13" y="3.5" width="7.5" height="7.5" rx="1.6" />
      <rect x="3.5" y="13" width="7.5" height="7.5" rx="1.6" />
      <rect x="13" y="13" width="7.5" height="7.5" rx="1.6" />
    </>
  ),
  /* The nib and its stroke, on the 45° the whole icon set would draw a pen on.
   * No underline bar: at 13px it collides with the nib and reads as smudge. */
  pencil: (
    <>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4z" />
      <path d="m14.5 5.5 4 4" />
    </>
  ),
  /* Lid, body, two staves. The staves are what stop it reading as a bucket. */
  trash: (
    <>
      <path d="M4 6.5h16" />
      <path d="M9.5 6.5V4.8c0-.7.6-1.3 1.3-1.3h2.4c.7 0 1.3.6 1.3 1.3v1.7" />
      <path d="M6.5 6.5 7.4 19a1.6 1.6 0 0 0 1.6 1.5h6a1.6 1.6 0 0 0 1.6-1.5l.9-12.5" />
      <path d="M10.5 10v6.5M13.5 10v6.5" />
    </>
  ),
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

  /* ---- rail section marks ----
   * Stroked, on the same 24 grid as the rest. Each one has to survive at 15px
   * beside a word, so every shape here is at most three strokes: detail added
   * at this size turns to grey mush and reads as a smudge, not a symbol. */

  /* Pauses are measured in milliseconds, so the mark is a clock. Hands at
   * 10-and-2 rather than 3-and-6: a horizontal hand lands on the circle's
   * flattest arc and disappears into it. */
  clock: (
    <>
      <circle cx="12" cy="12" r="8.75" />
      <path d="M12 6.75V12l3.6 2.4" />
    </>
  ),
  /* Two overlapping Ls — the photographer's crop tool, and the only widely-read
   * symbol for "the frame is smaller than the picture". */
  crop: (
    <>
      <path d="M7 2.5v14.5h14.5" />
      <path d="M2.5 7H17v14.5" />
    </>
  ),
  /* A four-point star with concave sides, not a five-point one: the pointed
   * star is "favourite", this is "cleaned up". The second, smaller star is what
   * stops the first reading as a plus sign. */
  sparkle: (
    <>
      <path d="M11 3.5c0 4 1.6 5.6 5.6 5.6-4 0-5.6 1.6-5.6 5.6 0-4-1.6-5.6-5.6-5.6 4 0 5.6-1.6 5.6-5.6Z" />
      <path d="M17.5 14.5c0 2 .8 2.9 2.8 2.9-2 0-2.8.8-2.8 2.8 0-2-.8-2.8-2.8-2.8 2 0 2.8-.9 2.8-2.9Z" />
    </>
  ),
  /* ONE note with a flag — deliberately not the two-note `audio` mark above it
   * in the same rail. Music is a bed you add; audio is the track you recorded,
   * and the two must not be the same picture. */
  music: (
    <>
      <path d="M17.5 17.5V4l3.5 2.2" />
      <circle cx="14" cy="17.5" r="3.5" />
    </>
  ),
  /* The caption box, with a long line over a short one — the ragged-right shape
   * of a real two-line subtitle, which is what makes it read as text rather
   * than as a generic card. */
  captions: (
    <>
      <rect x="2.5" y="5" width="19" height="14" rx="2.75" />
      <path d="M6.75 10.75h10.5M6.75 14.5h6" />
    </>
  ),
  /* Two rails, two knobs, at different offsets. Equal offsets read as an equals
   * sign; unequal ones read as "these are set to different values". */
  sliders: (
    <>
      <path d="M3.5 8.5h9.5M17 8.5h3.5M3.5 15.5h3.5M11 15.5h9.5" />
      <circle cx="15" cy="8.5" r="2" />
      <circle cx="9" cy="15.5" r="2" />
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
