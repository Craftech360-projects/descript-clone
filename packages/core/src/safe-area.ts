/**
 * Where each platform draws its own interface over your video.
 *
 * A reel is not shown on a blank screen. Instagram, TikTok and YouTube all paint
 * their own furniture on top of it — a caption and username block along the
 * bottom, an action rail down the right, a status and progress strip at the top.
 * Compose a caption at y=0.85, which is this app's default, and on Reels it
 * lands underneath the platform's own caption bar. You find out after posting.
 *
 * So these are PREVIEW guides. They are never burned in, never sent to the
 * render, and never change a single pixel of the output — they only draw where
 * not to put anything.
 *
 * ── on the numbers ──────────────────────────────────────────────────────────
 *
 * Insets are fractions of the frame, not pixels, so they hold at any output
 * size. The pixel figures in the comments are for the 1080x1920 canvas they were
 * published against.
 *
 * They are CONSERVATIVE COMPOSITION MARGINS rather than a pixel-exact trace of
 * each app's chrome — platforms move their furniture between releases and differ by
 * device, so a guide that claims to be exact would be wrong more often than one
 * that claims to be safe. Treat the shaded band as "do not compose here", not as
 * "this exact rectangle is covered".
 */

export type Platform = 'reels' | 'tiktok' | 'shorts' | 'all';

/** Fractions of the frame, measured inward from each edge. */
export interface SafeInsets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PlatformGuide {
  id: Platform;
  label: string;
  /** What the covered area actually is, for the panel to explain itself. */
  hint: string;
  insets: SafeInsets;
}

const REF_W = 1080;
const REF_H = 1920;

const px = (top: number, bottom: number, left: number, right: number): SafeInsets => ({
  top: top / REF_H,
  bottom: bottom / REF_H,
  left: left / REF_W,
  right: right / REF_W,
});

export const PLATFORM_GUIDES: readonly PlatformGuide[] = [
  {
    id: 'reels',
    label: 'Instagram Reels',
    hint: 'Caption, username and audio strip along the bottom; action rail on the right.',
    // ~108 top, ~320 bottom, ~60 sides at 1080x1920.
    insets: px(108, 320, 60, 60),
  },
  {
    id: 'tiktok',
    label: 'TikTok',
    hint: 'Caption block bottom-left, action rail down the right, search and tabs on top.',
    // ~130 top, ~250 bottom, ~60 sides.
    insets: px(130, 250, 60, 60),
  },
  {
    id: 'shorts',
    label: 'YouTube Shorts',
    hint: 'Title and channel row at the bottom, action rail right, progress bar underneath.',
    // ~180 top, ~300 bottom.
    insets: px(180, 300, 60, 60),
  },
  {
    id: 'all',
    label: 'All three',
    hint: 'The worst case of each edge — safe everywhere you might post.',
    // Filled in below from the three above, so it can never drift from them.
    insets: px(0, 0, 0, 0),
  },
] as const;

/**
 * The union of every platform's furniture: the largest inset on each edge.
 *
 * Derived rather than typed out, because a hand-copied fourth set is a fourth
 * thing to update and the first one anybody forgets.
 */
export function strictestInsets(): SafeInsets {
  const real = PLATFORM_GUIDES.filter((g) => g.id !== 'all');
  return {
    top: Math.max(...real.map((g) => g.insets.top)),
    bottom: Math.max(...real.map((g) => g.insets.bottom)),
    left: Math.max(...real.map((g) => g.insets.left)),
    right: Math.max(...real.map((g) => g.insets.right)),
  };
}

export function insetsFor(platform: Platform): SafeInsets {
  if (platform === 'all') return strictestInsets();
  const guide = PLATFORM_GUIDES.find((g) => g.id === platform);
  return guide ? guide.insets : { top: 0, bottom: 0, left: 0, right: 0 };
}

/**
 * The safe rectangle, as fractions of the frame — what the overlay outlines and
 * what a placement check would test against.
 */
export function safeBox(platform: Platform): { x: number; y: number; width: number; height: number } {
  const i = insetsFor(platform);
  return {
    x: i.left,
    y: i.top,
    width: Math.max(0, 1 - i.left - i.right),
    height: Math.max(0, 1 - i.top - i.bottom),
  };
}

/**
 * Is a caption anchored at (x, y) clear of the platform's furniture?
 *
 * The anchor is the CENTRE of the caption box — the same convention
 * CaptionSettings uses — so the box's own half-height is what decides it, not
 * the anchor alone. A caption whose anchor is safe while its lower half is under
 * the like button is not safe.
 */
export function captionIsSafe(
  platform: Platform,
  anchor: { x: number; y: number },
  box: { width: number; height: number },
): boolean {
  const safe = safeBox(platform);
  const top = anchor.y - box.height / 2;
  const bottom = anchor.y + box.height / 2;
  const left = anchor.x - box.width / 2;
  const right = anchor.x + box.width / 2;
  return (
    top >= safe.y - 1e-6 &&
    bottom <= safe.y + safe.height + 1e-6 &&
    left >= safe.x - 1e-6 &&
    right <= safe.x + safe.width + 1e-6
  );
}
