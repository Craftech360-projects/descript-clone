/**
 * Caption appearance: one settings object that BOTH the on-screen preview and
 * the burned ASS read from.
 *
 * Two rules keep the preview honest, and everything here follows from them.
 *
 * 1. Resolution independence. Sizes are authored against a 1080p reference and
 *    scaled by the real frame height; position is a 0..1 fraction of the frame.
 *    So a caption placed on a 4K master lands in the same place on a 720p
 *    proxy, and the monitor — which is a few hundred pixels wide — can preview
 *    it truthfully at any size.
 *
 * 2. Fonts must exist at RENDER time, not just in the browser. libass resolves
 *    families through fontconfig on the machine running ffmpeg; a family that
 *    is missing there silently falls back, and the burn stops matching the
 *    preview. See CAPTION_FONTS.
 */

export type Backdrop = 'none' | 'shadow' | 'box';

export interface CaptionSettings {
  /** Burn on render, and draw in the monitor. Off means no captions anywhere. */
  enabled: boolean;
  /** Family name as libass will resolve it. Must be one of CAPTION_FONTS. */
  font: string;
  /** Type size in px AT 1080p, scaled to the real frame height on render. */
  fontSize: number;
  /** #RRGGBB. The colour a word settles on once spoken. */
  color: string;
  /**
   * Light words up one at a time as they are spoken — the social-captions look.
   *
   * This used to be unconditional in the burn and absent from the preview, which
   * is the worst of both: the monitor showed flat white text and the export came
   * back animated in a colour nobody had chosen. It is one setting now, and both
   * sides read it.
   */
  karaoke: boolean;
  /**
   * #RRGGBB a word wears BEFORE it is spoken. Only meaningful with karaoke on.
   *
   * Note the direction, because it is the opposite of what "highlight" suggests:
   * ASS \k starts a word in SecondaryColour and flips it to PrimaryColour once
   * sung. So this is the WAITING colour and `color` is where each word lands.
   */
  highlightColor: string;
  /** #RRGGBB outline drawn around the glyphs. */
  strokeColor: string;
  /** Outline width in px at 1080p. 0 disables the outline. */
  strokeWidth: number;
  /** What sits behind the text for legibility over busy footage. */
  backdrop: Backdrop;
  /** Force uppercase — the social-captions look. Render-time only. */
  allCaps: boolean;
  /** Wrap a cue past this many characters. */
  maxChars: number;
  /** Anchor of the text block, as a 0..1 fraction of the frame. */
  x: number;
  y: number;
}

/**
 * The reference height every size is authored against. Picking 1080 rather than
 * "whatever this project happens to be" means the same settings look the same
 * across projects, and the numbers in the UI mean something stable.
 */
export const CAPTION_REFERENCE_HEIGHT = 1080;

export const DEFAULT_CAPTIONS: CaptionSettings = {
  enabled: false,
  font: 'Arial',
  fontSize: 48,
  color: '#FFFFFF',
  // Both carried over from what the burn already did, so an existing project
  // renders exactly as it did before this became a setting.
  karaoke: true,
  highlightColor: '#FFD500',
  strokeColor: '#000000',
  strokeWidth: 3,
  backdrop: 'none',
  allCaps: false,
  maxChars: 42,
  x: 0.5,
  // Not 0.5: captions sit low by convention, and low enough to clear a face but
  // high enough to clear a player's scrubber.
  y: 0.85,
};

/**
 * The only fonts offered, and why the list is this short.
 *
 * Each of these is metric-compatible with a Liberation face, and fontconfig
 * ships the alias rules (30-metric-aliases.conf) that map them. So "Arial"
 * resolves to real Arial on a Mac or Windows box and to Liberation Sans in the
 * Debian image — same widths, same wrap points, same size on screen.
 *
 * Adding a face that has no such alias (Impact, Georgia, Inter) would look right
 * here and silently fall back to a default in the container. That is the exact
 * trap the Dockerfile warns about, so the list stays limited to what survives
 * the trip.
 */
export const CAPTION_FONTS: Array<{ id: string; label: string; css: string }> = [
  {
    id: 'Arial',
    label: 'Sans — Arial / Liberation Sans',
    css: 'Arial, "Liberation Sans", "Helvetica Neue", sans-serif',
  },
  {
    id: 'Times New Roman',
    label: 'Serif — Times / Liberation Serif',
    css: '"Times New Roman", "Liberation Serif", Times, serif',
  },
  {
    id: 'Courier New',
    label: 'Mono — Courier / Liberation Mono',
    css: '"Courier New", "Liberation Mono", monospace',
  },
];

/** The CSS stack that previews `font`, or the sans stack if it is unknown. */
export function fontCss(font: string): string {
  return (CAPTION_FONTS.find((f) => f.id === font) ?? CAPTION_FONTS[0]).css;
}

/**
 * Fill in whatever a stored settings object is missing.
 *
 * Persisted captions are as old as the project that saved them, so any field
 * added later arrives undefined — and `stored ?? DEFAULT_CAPTIONS` does NOT
 * cover that: the object exists, so the fallback never fires and the new key
 * stays missing. That shipped once. `highlightColor` came back undefined on
 * every pre-existing project, and the colour swatch calls .toUpperCase() on it,
 * so opening the control blanked the entire editor.
 *
 * Per-field, therefore, and at every door: this is the only way a
 * CaptionSettings should ever be built from something read off disk or a wire.
 */
export function normalizeCaptions(stored: Partial<CaptionSettings> | undefined): CaptionSettings {
  const merged = { ...DEFAULT_CAPTIONS };
  if (stored) {
    for (const key of Object.keys(DEFAULT_CAPTIONS) as Array<keyof CaptionSettings>) {
      const value = stored[key];
      // An explicit undefined must not overwrite the default either — that is
      // exactly what a JSON body with an omitted field destructures to.
      if (value !== undefined) merged[key] = value as never;
    }
  }
  return merged;
}

/**
 * ASS MarginL/MarginR/MarginV, in frame pixels.
 *
 * These do not move a \pos'd caption — position wins — but libass still wraps a
 * line at PlayResX minus the horizontal pair. Measured against the bundled
 * ffmpeg at 1920 wide: a 1830px line stays on one line and an 1884px line
 * breaks, so the limit is the 1840 this implies.
 */
export const CAPTION_MARGIN = 40;

/**
 * The fraction of the frame width a caption line may fill before it wraps.
 *
 * The preview used to guess this as `maxChars * 1.9`, which is a statement
 * about character COUNT and so drifts with type size: at 48px a 42-character
 * line filled 45% of frame and neither side wrapped, but at 90px it filled 84%
 * — past the guess, under the real limit — so the monitor broke the line in two
 * and the export kept it on one.
 */
export function captionWrapFraction(frameWidth: number): number {
  if (!Number.isFinite(frameWidth) || frameWidth <= 2 * CAPTION_MARGIN) return 1;
  return (frameWidth - 2 * CAPTION_MARGIN) / frameWidth;
}

/** How much to multiply a 1080p-authored size by to land on this frame. */
export function captionScale(frameHeight: number): number {
  if (!Number.isFinite(frameHeight) || frameHeight <= 0) return 1;
  return frameHeight / CAPTION_REFERENCE_HEIGHT;
}

/**
 * #RRGGBB -> &HAABBGGRR.
 *
 * ASS is little-endian: the byte order is alpha, BLUE, green, red — not RGB.
 * Getting this backwards does not error, it just silently swaps red and blue,
 * which is the kind of bug you stare straight through.
 *
 * `alpha` is ASS alpha, where 0 is opaque and 255 is invisible — also inverted
 * from every other convention.
 */
export function hexToAss(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  // A malformed colour must not produce malformed ASS: the whole style line
  // would fail to parse and libass would drop every caption.
  const rgb = m ? m[1] : 'FFFFFF';
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  const a = clampByte(alpha).toString(16).padStart(2, '0');
  return `&H${a}${b}${g}${r}`.toUpperCase();
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

/**
 * What `strokeColor` actually paints, which depends on the backdrop.
 *
 * In box mode libass fills the box with OutlineColour and draws no glyph
 * outline at all — so the one colour means "outline" in two modes and "box" in
 * the third. Both the ASS writer and the preview go through this, because the
 * first version of the preview drew a 50%-black box while the burn drew an
 * opaque stroke-coloured one, and only a test render caught it.
 */
export function strokeRole(backdrop: Backdrop): 'outline' | 'box' {
  return backdrop === 'box' ? 'box' : 'outline';
}

/** The CSS fill for the preview's backdrop, or null when there is none. */
export function captionBoxFill(settings: CaptionSettings): string | null {
  return settings.backdrop === 'box' ? settings.strokeColor : null;
}

/** Clamp a caption anchor into the frame, so it can never be dragged off-screen. */
export function clampAnchor(x: number, y: number): { x: number; y: number } {
  return { x: clamp01(x), y: clamp01(y) };
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
