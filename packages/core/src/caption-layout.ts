/**
 * Where a caption's lines break, and where each line sits.
 *
 * This exists because a caption now has a BOX — a width and a height, dragged in
 * the monitor — and something has to decide how the cue's words fold into that
 * box. The rule the rest of the app depends on is the same one that made the
 * preview honest in the first place: layout is decided ONCE, here, and both the
 * monitor and the ASS burn are handed the result.
 *
 * Two things follow from that, and they are the whole design.
 *
 * 1. The box does not change WHICH words share a caption. That is toCues' job
 *    and it is still governed by maxChars, so narrowing the box cannot silently
 *    re-chunk the transcript — the same characters stay in the same cue, and all
 *    that changes is whether they sit on one line or three. Widen the box past
 *    the cue's own length and it comes back onto a single line.
 *
 * 2. Line spacing is ours, not libass'. toAss emits one Dialogue per line with
 *    its own \pos rather than one event full of \N, precisely so the vertical
 *    step is a number we computed and the monitor can reproduce exactly. ASS has
 *    no leading control; if we let libass stack the lines, the box's height
 *    would be a preview-only fiction.
 *
 * ── on measuring text without a font engine ──────────────────────────────────
 *
 * Wrapping to a WIDTH means knowing how wide a string is, and neither the burn
 * (libass, on a render box) nor this module (plain TS, in a browser and in Node)
 * can consult the other's rasteriser. So the widths below are the published
 * advance widths of the Core-14 faces, in 1/1000 em: Helvetica for the sans
 * stack, Times for the serif, a flat 600 for the mono. Arial and Liberation Sans
 * are metric-compatible with Helvetica and Liberation Serif with Times, which is
 * exactly why CAPTION_FONTS is limited to faces that survive that trip.
 *
 * This is an APPROXIMATION, and it is worth being precise about which part is
 * approximate. The break points are not: they are computed here and honoured
 * verbatim by both sides, so the preview and the burn always break in the same
 * places. What is approximate is only whether a line the box said would fit
 * really does fit to the pixel — kerning, hinting and the bold synthesis factor
 * below all move real ink by a percent or two. A line can therefore sit slightly
 * proud of the guide rectangle. It cannot break somewhere the burn does not.
 */

import { captionScale, type CaptionSettings } from './caption-style.ts';

/** The frame the captions are being laid out on, in pixels. */
export interface LayoutFrame {
  width: number;
  height: number;
}

export interface CaptionLine {
  /** Index of this line's first word in the cue, and one past its last. */
  from: number;
  to: number;
  /** The words joined, exactly as they will be drawn. */
  text: string;
  /** Offset of this line's CENTRE from the block's centre, in frame pixels. */
  dy: number;
  /** Measured width, in frame pixels. See the note on approximation above. */
  width: number;
}

/**
 * Leading as a multiple of the type size, when the box gives no extra room.
 *
 * Matches the `line-height: 1.2` the monitor's caption CSS has always used, and
 * is the floor below which the box's height can never squeeze the lines — two
 * lines of 48px type overlapping into each other is not a layout anybody asked
 * for by dragging a handle.
 */
export const CAPTION_LINE_HEIGHT = 1.2;

/** Advance widths in 1/1000 em for U+0020..U+007E. */
type WidthTable = readonly number[];

// prettier-ignore
const HELVETICA: WidthTable = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
  556, 556, 556, 556, 556, 556, 556, 556, 556, 556,
  278, 278, 584, 584, 584, 556, 1015,
  667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
  778, 722, 667, 611, 722, 667, 944, 667, 667, 611,
  333, 278, 333, 469, 556, 333,
  556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556,
  556, 333, 500, 278, 556, 500, 722, 500, 500, 500,
  334, 260, 334, 584,
];

// prettier-ignore
const TIMES: WidthTable = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250, 278,
  500, 500, 500, 500, 500, 500, 500, 500, 500, 500,
  278, 278, 564, 564, 564, 444, 921,
  722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611, 889, 722, 722, 556,
  722, 667, 556, 611, 722, 722, 944, 722, 722, 611,
  333, 278, 333, 469, 500, 333,
  444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500,
  500, 333, 389, 278, 500, 500, 722, 500, 500, 444,
  480, 200, 480, 541,
];

interface Metrics {
  /** Proportional widths, or null for a fixed-pitch face. */
  widths: WidthTable | null;
  /** Every glyph's width, for a fixed-pitch face. */
  fixed: number;
  /**
   * How much wider the BOLD cut runs than the regular one, averaged over the
   * lowercase alphabet.
   *
   * Not a fudge factor: toAss hardcodes Bold: -1 and the monitor's CSS sets
   * font-weight 700, so every caption this app has ever drawn is bold, and
   * measuring it against regular widths would under-count every line by about
   * the width of two characters in forty.
   */
  bold: number;
}

const SANS: Metrics = { widths: HELVETICA, fixed: 0, bold: 1.07 };

/**
 * Metrics per CAPTION_FONTS id.
 *
 * An IMPORTED font is not here and cannot be — its widths live in a file on the
 * server, and reading hmtx out of it would be a second font engine to keep in
 * step with the first. It falls back to the sans table, which is right to within
 * a few percent for the display faces people actually import and wrong in the
 * same direction on both sides, so the two still agree with each other.
 */
const METRICS: Record<string, Metrics> = {
  Arial: SANS,
  'Times New Roman': { widths: TIMES, fixed: 0, bold: 1.09 },
  'Courier New': { widths: null, fixed: 600, bold: 1 },
};

/** Width of 'n' — what a character outside the table is charged. */
const FALLBACK = 'n'.codePointAt(0)! - 32;

/**
 * How wide `text` will be drawn, in pixels, at `fontPx` in `font`.
 *
 * Exported because the monitor uses it to decide nothing at all — every break is
 * already made here — but the box guide needs a width to draw, and drawing it
 * from a second measurement would be the two-engines bug all over again.
 */
export function measureCaption(
  text: string,
  font: string,
  fontPx: number,
  allCaps = false,
): number {
  const m = METRICS[font] ?? SANS;
  const s = allCaps ? text.toUpperCase() : text;

  let units = 0;
  for (const ch of s) {
    if (m.widths === null) {
      units += m.fixed;
      continue;
    }
    const code = ch.codePointAt(0)!;
    units += code >= 32 && code <= 126 ? m.widths[code - 32] : m.widths[FALLBACK];
  }
  return (units / 1000) * fontPx * m.bold;
}

/**
 * Fold a cue's words into the caption box and place each line.
 *
 * `words` is the cue's word TEXTS in order, so the caller can map a line's
 * from/to straight back onto karaokeSpans — which is how the burn keeps \k
 * timing correct across a line break and how the monitor knows which words on
 * which line have been spoken.
 *
 * Greedy, and deliberately: a word that does not fit an empty line stays on it
 * alone and overflows rather than being hyphenated or dropped. That matches what
 * the burn does with an over-long line (WrapStyle 2 lets it run off the frame)
 * and it matches what the monitor draws, so an overflow is visible in the
 * preview rather than discovered in the export.
 */
export function layoutCaption(
  words: readonly string[],
  settings: CaptionSettings,
  frame: LayoutFrame,
): CaptionLine[] {
  if (words.length === 0) return [];

  const scale = captionScale(frame.height);
  const fontPx = settings.fontSize * scale;
  const maxWidth = Math.max(1, settings.boxWidth * frame.width);
  const measure = (text: string) => measureCaption(text, settings.font, fontPx, settings.allCaps);

  const lines: CaptionLine[] = [];
  let from = 0;
  let text = '';

  for (let i = 0; i < words.length; i++) {
    const candidate = text === '' ? words[i] : `${text} ${words[i]}`;
    // Measured whole rather than summed from a running total, because the space
    // between two words is itself a glyph with a width, and a per-word tally
    // drifts by one space per break.
    if (text !== '' && measure(candidate) > maxWidth) {
      lines.push({ from, to: i, text, dy: 0, width: measure(text) });
      from = i;
      text = words[i];
    } else {
      text = candidate;
    }
  }
  lines.push({ from, to: words.length, text, dy: 0, width: measure(text) });

  // The box's height is ROOM, not a clamp. Whatever it gives beyond the natural
  // leading is shared out between the lines as extra air; below that the floor
  // wins, so a short box packs the lines at 1.2 and never overlaps them. With a
  // single line there is nothing to space and the height only reserves the area
  // the guide draws — which is still worth having, since it is the safe area you
  // are placing the caption inside.
  const step = Math.max(fontPx * CAPTION_LINE_HEIGHT, (settings.boxHeight * frame.height) / lines.length);
  const mid = (lines.length - 1) / 2;
  for (let i = 0; i < lines.length; i++) lines[i].dy = (i - mid) * step;

  return lines;
}
