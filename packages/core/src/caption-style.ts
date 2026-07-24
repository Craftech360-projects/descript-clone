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
  /** Split a cue past this many characters. */
  maxChars: number;
  /**
   * The caption BOX, as a 0..1 fraction of the frame, centred on (x, y).
   *
   * Width is where the lines break: a cue too wide for the box folds onto
   * another line, and widening the box past the cue's own length brings it back
   * onto one. It does NOT change which words share a caption — that is maxChars,
   * and keeping the two separate is the point. Narrowing the box re-flows the
   * same characters; it never re-chunks the transcript.
   *
   * Height is the vertical room those lines get. Anything beyond the natural
   * leading is shared out between them as extra air. See layoutCaption, which is
   * the one place either number is turned into a layout.
   */
  boxWidth: number;
  boxHeight: number;
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
  karaoke: true,
  // The brand gold (the JumpCut wordmark). The word not yet spoken waits in the
  // product's own colour and settles to white as it is sung — not the stock
  // #FFD500 highlighter yellow, which belongs to no palette here.
  highlightColor: '#C8A87A',
  strokeColor: '#000000',
  // In box mode this is the box's padding, not an outline width — see strokeRole.
  strokeWidth: 3,
  // A solid box, because a default has to survive footage nobody has shot yet.
  // An outline holds up over most pictures and disappears over a few — high-key
  // white, snow, a blown-out sky — and the one it fails over is exactly the one
  // where you would not think to check. The box is legible over anything, which
  // is the only property a default can be chosen on.
  backdrop: 'box',
  allCaps: false,
  maxChars: 42,
  // Wide enough that a default 42-character cue at 48px still lands on ONE line
  // — measured through layoutCaption at 1920x1080, a full-length cue comes out
  // around 0.62 of the frame — so turning captions on gives the same single-line
  // result it always did, and the box is something you reach for rather than
  // something that reshapes your captions the moment it exists.
  boxWidth: 0.8,
  // Two lines of 48px type at the natural 1.2 leading, near enough. So a cue
  // that does wrap wraps at the leading the monitor has always drawn, and the
  // handle adds air from there rather than starting out already spread.
  boxHeight: 0.11,
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
 * The CSS font-family the preview should use for `font`, imported fonts included.
 *
 * A built-in resolves through its metric-compatible stack (fontCss). An imported
 * family — one whose exact name is in `customFamilies`, loaded by an @font-face —
 * is quoted and used directly, with a sans fallback for the flash before the file
 * arrives. The quotes escaped so a family with one in its name cannot break out.
 *
 * This is the preview's mirror of the burn: toAss writes the same `font` string
 * as the ASS Fontname, which libass resolves to the identical file via fontsdir.
 */
export function fontStack(font: string, customFamilies: readonly string[] = []): string {
  if (customFamilies.includes(font)) return `"${font.replace(/"/g, '')}", sans-serif`;
  return fontCss(font);
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
  // The highlight default used to be #FFD500 highlighter yellow, a colour no one
  // chose — it was just what the app shipped. Retire it: a project still carrying
  // that exact value gets the brand gold instead, so old projects come forward to
  // the logo colour on their own. A gold anyone deliberately picked is untouched.
  if (merged.highlightColor.toUpperCase() === LEGACY_HIGHLIGHT) {
    merged.highlightColor = DEFAULT_CAPTIONS.highlightColor;
  }
  // The box is a divisor away from being a disaster: a width of 0 off the wire
  // wraps every single word onto its own line, and a negative one wraps forever.
  // Clamped here rather than in layoutCaption so the number the UI shows and the
  // number the burn uses are the same one.
  const box = clampBox(merged.boxWidth, merged.boxHeight);
  merged.boxWidth = box.width;
  merged.boxHeight = box.height;
  return merged;
}

/** The pre-brand highlight default, rewritten to the logo gold on load. */
const LEGACY_HIGHLIGHT = '#FFD500';

/**
 * ASS MarginL/MarginR/MarginV, in frame pixels.
 *
 * Inert, and deliberately kept that way. They do not move a \pos'd caption —
 * position wins — and under WrapStyle 2 they no longer bound line length
 * either. They are written because the format expects them; nothing should
 * start deriving a layout rule from them again.
 */
export const CAPTION_MARGIN = 40;

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

/**
 * The narrowest and shortest the caption box may be dragged.
 *
 * A floor rather than a free drag because both numbers are divisors — width
 * decides how many words fit a line and height is divided by the line count —
 * and a box dragged to nothing is a caption nobody can find again to drag back.
 * A tenth of the frame still holds a word or two at any sane size.
 */
export const MIN_CAPTION_BOX = { width: 0.1, height: 0.04 };

/** Clamp a dragged caption box to something that can still hold text. */
export function clampBox(width: number, height: number): { width: number; height: number } {
  return {
    width: clampRange(width, MIN_CAPTION_BOX.width, DEFAULT_CAPTIONS.boxWidth),
    height: clampRange(height, MIN_CAPTION_BOX.height, DEFAULT_CAPTIONS.boxHeight),
  };
}

function clampRange(n: number, min: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(1, n));
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}
