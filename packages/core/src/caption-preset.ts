import {
  DEFAULT_CAPTIONS,
  normalizeCaptions,
  type CaptionSettings,
} from './caption-style.ts';
import { strictestInsets } from './safe-area.ts';

/**
 * A named caption look you can re-apply.
 *
 * The caption panel is a dozen controls — font, size, two colours, outline
 * colour and width, backdrop, caps, box width, box height, characters per cue —
 * and a series of reels wants ONE answer to all of them, every time. Re-dialling
 * that per video is the repeated work this removes.
 *
 * ── why a style is not part of the document ──────────────────────────────────
 *
 * CaptionSettings live on the Doc, and rightly: they are what THIS video looks
 * like, they undo with everything else, and they are saved with the project. A
 * style is the opposite thing — it is reused ACROSS projects, it is the reason
 * you opened the next one, and it belongs to the person rather than to the file.
 * So the saved list is a user-level preference (localStorage, alongside the
 * custom filler words and the on-import chain), and this module is only the pure
 * part: what a style IS, how one is captured, and how one is put back on.
 *
 * ── why the built-ins are code and not seeded data ───────────────────────────
 *
 * Writing the three presets into a user's saved list on first run would freeze
 * them at whatever this build thought good, forever, on every machine that ever
 * ran it. Kept as code, they improve when the app does, they cost no storage,
 * and "delete" is simply not offered on them — there is nothing to delete.
 */

export interface CaptionStyle {
  /**
   * Identity, derived from the name rather than generated.
   *
   * A style library is small and named by hand, so the name IS the key: saving
   * "Podcast" twice replaces the first rather than leaving two identical chips
   * you cannot tell apart. See styleKey.
   */
  id: string;
  name: string;
  /**
   * The look.
   *
   * A full CaptionSettings including `enabled`, even though applying a style
   * never reads that field — see applyCaptionStyle. Storing the whole object
   * means it can go through normalizeCaptions, which is the only sanctioned way
   * to build a CaptionSettings from something read off disk.
   */
  settings: CaptionSettings;
  /** True for the three that ship with the app. They cannot be deleted. */
  builtIn?: boolean;
}

/**
 * Cap on the saved list.
 *
 * Not a storage worry — a style is a few hundred bytes. It is a UI one: the
 * chips wrap under the font picker, and past a couple of dozen the row stops
 * being something you scan and starts being something you search, which is a
 * different feature. A hand-edited or corrupted localStorage entry also cannot
 * grow the row without limit.
 */
export const MAX_CAPTION_STYLES = 24;

/** How long a style name may be — a chip has to hold it on one line. */
export const MAX_STYLE_NAME = 32;

/**
 * The lowest a box of this height can be centred and still clear every
 * platform's furniture.
 *
 * Derived from safe-area.ts rather than typed out, for the reason that module
 * gives about its own 'all' entry: a hand-copied number is a second thing to
 * update and the first one anybody forgets. It matters here specifically —
 * safe-area's own header points at this app's default y of 0.85 as the example
 * of a caption that lands underneath the Reels caption bar, and a preset shipped
 * for reels must not repeat that.
 *
 * The extra hundredth is clearance, not superstition: the presets are checked
 * against captionIsSafe in the tests, and sitting exactly on the boundary makes
 * that check a coin toss on floating-point rounding.
 */
function lowestSafeY(boxHeight: number): number {
  const y = 1 - strictestInsets().bottom - boxHeight / 2 - 0.01;
  // Floor rather than round: rounding can push the value back over the line the
  // subtraction above just cleared.
  return Math.floor(y * 1000) / 1000;
}

/**
 * The three that ship.
 *
 * Three looks that differ in KIND, not in degree — an outlined caps caption, a
 * boxed one, and a quiet serif — because a fourth variation on the first is not
 * a starting point, it is a preference you should be saving yourself.
 *
 * Every one of them names a font from CAPTION_FONTS. That list is three faces on
 * purpose (libass resolves families through fontconfig on whatever machine runs
 * the render, and only these three have metric-compatible Liberation aliases
 * there), so a preset reaching for Impact or Inter would preview correctly here
 * and silently fall back in the container. Presets do not get to widen that.
 *
 * The sizes are authored at the 1080p reference height, so on a 1080x1920 reel
 * they are drawn at 1.78x what the number says — which is why they look small
 * written down and are not.
 */
export const BUILT_IN_CAPTION_STYLES: readonly CaptionStyle[] = [
  {
    id: 'reel-bold',
    name: 'Reel bold',
    builtIn: true,
    settings: normalizeCaptions({
      ...DEFAULT_CAPTIONS,
      font: 'Arial',
      fontSize: 44,
      allCaps: true,
      karaoke: true,
      color: '#FFFFFF',
      highlightColor: DEFAULT_CAPTIONS.highlightColor,
      // Outline, not a box: caps this size over a face read better with the
      // picture showing through, and the stroke is what keeps them legible.
      backdrop: 'none',
      strokeColor: '#000000',
      strokeWidth: 6,
      // Short cues. At this size a 1080-wide reel fits about 17 capitals to a
      // line, so 28 characters is the two-line phrase the look is built on.
      maxChars: 28,
      boxWidth: 0.86,
      boxHeight: 0.14,
      x: 0.5,
      y: lowestSafeY(0.14),
    }),
  },
  {
    id: 'clean-box',
    name: 'Clean box',
    builtIn: true,
    settings: normalizeCaptions({
      ...DEFAULT_CAPTIONS,
      font: 'Arial',
      fontSize: 36,
      allCaps: false,
      // No karaoke: this is the one to reach for when the words matter more
      // than the motion — a recipe, a spec, anything read rather than watched.
      karaoke: false,
      color: '#FFFFFF',
      backdrop: 'box',
      strokeColor: '#000000',
      strokeWidth: 4,
      maxChars: 42,
      boxWidth: 0.86,
      boxHeight: 0.12,
      x: 0.5,
      y: lowestSafeY(0.12),
    }),
  },
  {
    id: 'quiet-serif',
    name: 'Quiet serif',
    builtIn: true,
    settings: normalizeCaptions({
      ...DEFAULT_CAPTIONS,
      font: 'Times New Roman',
      fontSize: 32,
      allCaps: false,
      karaoke: false,
      color: '#FFFFFF',
      // Shadow rather than a hard outline: at this size an outline thick enough
      // to matter starts eating the serifs it exists to protect.
      backdrop: 'shadow',
      strokeColor: '#000000',
      strokeWidth: 2,
      maxChars: 48,
      boxWidth: 0.86,
      boxHeight: 0.1,
      x: 0.5,
      y: lowestSafeY(0.1),
    }),
  },
];

/** The key a name saves under: trimmed, collapsed, case-folded. */
export function styleKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase().slice(0, MAX_STYLE_NAME);
}

/** Clean a name for display. Same trimming as styleKey, original case kept. */
export function styleName(name: string): string {
  return name.replace(/\s+/g, ' ').trim().slice(0, MAX_STYLE_NAME);
}

/** Capture the current look under a name. Returns null for an unusable name. */
export function captureCaptionStyle(name: string, settings: CaptionSettings): CaptionStyle | null {
  const display = styleName(name);
  if (!display) return null;
  return { id: styleKey(display), name: display, settings: normalizeCaptions(settings) };
}

/**
 * Put a style back on, keeping the things that are not part of a LOOK.
 *
 * `enabled` is the one field a style must never carry across. It is not an
 * appearance, it is whether this video has captions at all — and a style picker
 * that switches captions off because the look was captured while they were off
 * would be a trap you fall into once and never trust again.
 */
export function applyCaptionStyle(
  current: CaptionSettings,
  style: CaptionStyle,
): CaptionSettings {
  return { ...normalizeCaptions(style.settings), enabled: current.enabled };
}

/** Is the current look exactly this style? Everything but `enabled` compared. */
export function matchesCaptionStyle(current: CaptionSettings, style: CaptionStyle): boolean {
  const a = normalizeCaptions(current);
  const b = normalizeCaptions(style.settings);
  return (Object.keys(DEFAULT_CAPTIONS) as Array<keyof CaptionSettings>).every(
    (key) => key === 'enabled' || a[key] === b[key],
  );
}

/** Save (or replace) a style in a list, newest last. */
export function saveCaptionStyle(list: readonly CaptionStyle[], style: CaptionStyle): CaptionStyle[] {
  const without = list.filter((s) => s.id !== style.id);
  // The cap drops the OLDEST, which is the one you have gone longest without
  // reaching for — evicting the newest would silently discard the save you just
  // made, which reads as the feature being broken.
  return [...without, style].slice(-MAX_CAPTION_STYLES);
}

export function removeCaptionStyle(list: readonly CaptionStyle[], id: string): CaptionStyle[] {
  return list.filter((s) => s.id !== id);
}

/**
 * Coerce whatever came out of storage into a list of styles.
 *
 * Same contract as normalizeCaptions and loadAutoImport: this is a boundary, so
 * anything absent, mistyped or hand-edited is fixed HERE rather than reaching a
 * colour swatch as undefined and taking the editor down with it. Entries whose
 * name is gone are dropped — a style with no name has no chip to click.
 */
export function normalizeCaptionStyles(raw: unknown): CaptionStyle[] {
  if (!Array.isArray(raw)) return [];
  const out: CaptionStyle[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as { name?: unknown; settings?: unknown };
    const name = styleName(typeof record.name === 'string' ? record.name : '');
    if (!name) continue;
    const id = styleKey(name);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      name,
      settings: normalizeCaptions(
        record.settings && typeof record.settings === 'object'
          ? (record.settings as Partial<CaptionSettings>)
          : undefined,
      ),
    });
  }
  return out.slice(-MAX_CAPTION_STYLES);
}

/** One line describing a style, for the chip's tooltip. */
export function captionStyleSummary(style: CaptionStyle): string {
  const s = style.settings;
  const parts = [s.font, `${s.fontSize}px`];
  if (s.allCaps) parts.push('ALL CAPS');
  parts.push(s.backdrop === 'box' ? 'box' : s.backdrop === 'shadow' ? 'shadow' : `${s.strokeWidth}px outline`);
  if (s.karaoke) parts.push('word highlight');
  return parts.join(' · ');
}
