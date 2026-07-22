import { sourceToOutput, splicePoints } from './edl.ts';
import {
  CAPTION_MARGIN,
  captionScale,
  DEFAULT_CAPTIONS,
  hexToAss,
  type CaptionSettings,
} from './caption-style.ts';
import type { Edl, Transcript, Word } from './types.ts';

export interface Cue {
  /** Times are on the OUTPUT timeline, not the source. See below. */
  start: number;
  end: number;
  text: string;
  words: Word[];
}

export interface CaptionOptions {
  /** Wrap a cue past this many characters. ~42 is the broadcast convention. */
  maxChars?: number;
  /** Never hold a cue longer than this. */
  maxDurationMs?: number;
}

const DEFAULTS: Required<CaptionOptions> = {
  maxChars: 42,
  maxDurationMs: 5000,
};

/**
 * A silence shorter than this is closed by holding the earlier cue until the
 * next one starts.
 *
 * A cue ends at its last word and the next begins at its first, so the space
 * between them is the space between two words — not a pause. Measured on a real
 * 14-minute transcript: 275 of 307 gaps were under 500ms and the MEDIAN was
 * 41ms. At 30fps that is one blank frame, 275 times: a flicker, in the burn and
 * the preview both. Broadcast practice (BBC, Netflix) is the same rule — a gap
 * under ~12 frames reads as a glitch rather than a beat, so it is closed.
 *
 * Longer silences are real and stay blank. This threshold does NOT govern
 * seams; see below.
 */
const MIN_GAP_S = 0.5;

/**
 * Merge options over defaults, ignoring keys explicitly set to undefined.
 *
 * A plain `{ ...DEFAULTS, ...options }` does NOT do this: an undefined value
 * still overrides. Callers pull these straight out of a JSON body, where an
 * omitted field destructures to undefined — which silently blew maxChars away
 * and emitted the whole transcript as one unwrapped cue.
 */
function withDefaults<T extends object>(defaults: T, options: Partial<T>): T {
  const merged = { ...defaults };
  for (const key of Object.keys(options) as Array<keyof T>) {
    const value = options[key];
    if (value !== undefined) merged[key] = value as T[keyof T];
  }
  return merged;
}

/**
 * Build caption cues for the EDITED video.
 *
 * The detail that matters: cues must be timed against the OUTPUT timeline, not
 * the source. A word at 4:32 in the raw footage is not at 4:32 in a cut that
 * removed ninety seconds before it. Timing captions off source timestamps is the
 * single most common way this feature ships broken — everything drifts by
 * exactly the amount you cut.
 */
export function toCues(
  transcript: Transcript,
  edl: Edl,
  options: CaptionOptions = {},
): Cue[] {
  const opts = withDefaults(DEFAULTS, options);
  const maxDuration = opts.maxDurationMs / 1000;

  const cues: Cue[] = [];
  let current: Word[] = [];
  let currentStart = 0;
  let currentEnd = 0;

  const flush = () => {
    if (current.length === 0) return;
    cues.push({
      start: currentStart,
      end: currentEnd,
      text: current.map((w) => w.text).join(' '),
      words: current,
    });
    current = [];
  };

  for (const word of transcript.words) {
    if (word.deleted) continue;

    const start = sourceToOutput(edl, word.start);
    const end = sourceToOutput(edl, word.end - 0.001);
    // The word was cut, or lands in padding the EDL trimmed. Skip it.
    if (start === null || end === null) continue;

    const nextLength = current.map((w) => w.text).join(' ').length + word.text.length + 1;
    const wouldOverrun = current.length > 0 && nextLength > opts.maxChars;
    const wouldHoldTooLong = current.length > 0 && end - currentStart > maxDuration;
    // A jump backwards or a big forward skip means we crossed a cut: start a new
    // cue so no caption spans a splice.
    const crossedCut = current.length > 0 && start < currentEnd - 0.001;

    if (wouldOverrun || wouldHoldTooLong || crossedCut) flush();

    if (current.length === 0) currentStart = start;
    currentEnd = end;
    current.push(word);
  }
  flush();

  // Hold each cue until the next one starts, so the caption does not blank
  // between them. Two different reasons to close a gap:
  //
  //   short   — the space between two words, not a pause. See MIN_GAP_S.
  //   seam    — a splice lands in it, so this is time the editor REMOVED.
  //
  // The seam clause is what makes shortened pauses smooth. Shortening a pause
  // leaves a gap of exactly maxGapMs + 2*padMs — at the default 40ms padding and
  // a 500ms cap, 580ms, which sails past any fixed short-gap threshold. The
  // caption then blanked at every jump cut: the picture cuts (unavoidable, it is
  // the edit) and the caption cut with it (gratuitous, and the thing you notice).
  // Time the editor deliberately took out is not a beat to blank through.
  //
  // This does not weaken "a cue never spans a cut" above — that is about which
  // WORDS share a caption, and it still holds. This is only how long the last
  // one stays up.
  const splices = splicePoints(edl);
  for (let i = 0; i < cues.length - 1; i++) {
    const gap = cues[i + 1].start - cues[i].end;
    if (gap <= 0) continue;
    const seam = splices.some((s) => s > cues[i].end && s < cues[i + 1].start);
    if (seam || gap < MIN_GAP_S) cues[i].end = cues[i + 1].start;
  }

  return cues;
}

/**
 * Re-time cues for a render at `speed`.
 *
 * SIDECAR FILES ONLY. A burned caption must never go through this: the burn-in
 * filter runs before setpts (see render.ts), so its glyphs are painted at 1x and
 * rescaled along with the frames they sit on. Scaling those cues first would
 * apply speed twice and the captions would run ahead of the words by the square
 * of it. A .srt has no such ride — it is read by a player against the finished
 * file's clock, and that clock has already been divided by speed.
 *
 * The words go with them. toAss reads each word's start/end as a DELTA for its
 * karaoke \k tags, so leaving them at source rate would highlight each word at
 * 1x over a picture running at 1.2x — drifting further out with every word in
 * the cue. They are source timestamps being reused as durations; scaling them is
 * only meaningful because nothing downstream of here reads them as positions.
 */
export function scaleCues(cues: Cue[], speed: number): Cue[] {
  if (speed === 1) return cues;
  return cues.map((cue) => ({
    ...cue,
    start: cue.start / speed,
    end: cue.end / speed,
    words: cue.words.map((w) => ({ ...w, start: w.start / speed, end: w.end / speed })),
  }));
}

export function toSrt(cues: Cue[]): string {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
    .join('\n');
}

export function toVtt(cues: Cue[]): string {
  const body = cues
    .map((cue) => `${vttTime(cue.start)} --> ${vttTime(cue.end)}\n${cue.text}\n`)
    .join('\n');
  return `WEBVTT\n\n${body}`;
}

/** One word of a cue, placed on the OUTPUT clock. */
export interface Span {
  text: string;
  start: number;
  end: number;
}

/**
 * What a cue's \k tags compile to, as absolute times.
 *
 * Both the burn and the preview go through this, and that is the entire point.
 * \k is a run of DURATIONS in centiseconds, so the position of the fourth word
 * is the sum of the three before it — reconstruct that sum differently in two
 * places and the preview highlights a word the export does not. Including the
 * centisecond rounding: it is a real quantisation the burn performs, up to 5ms
 * per word and cumulative across a cue, so the preview performs it too.
 */
export function karaokeSpans(cue: Cue): Span[] {
  const spans: Span[] = [];
  let t = cue.start;
  for (let i = 0; i < cue.words.length; i++) {
    const word = cue.words[i];
    const next = cue.words[i + 1];
    const end = next ? sourceGap(word, next) : word.end;
    const seconds = karaokeCentiseconds(word.start, end) / 100;
    spans.push({ text: word.text, start: t, end: t + seconds });
    t += seconds;
  }
  return spans;
}

/** \k's unit. Floored at 1 — a zero-length syllable is skipped entirely by libass. */
function karaokeCentiseconds(start: number, end: number): number {
  return Math.max(1, Math.round((end - start) * 100));
}

/** The frame the captions are being burned onto. */
export interface Frame {
  width: number;
  height: number;
}

const REFERENCE_FRAME: Frame = { width: 1920, height: 1080 };

/**
 * ASS subtitles for burn-in, with per-word karaoke timing (\k tags) — the
 * animated-caption look. ffmpeg renders these natively via the subtitles filter.
 *
 * Sizes arrive authored against 1080p and are scaled to `frame` here, so the
 * caller passes the same CaptionSettings whatever the project's resolution.
 */
export function toAss(
  cues: Cue[],
  settings: Partial<CaptionSettings> = {},
  frame: Frame = REFERENCE_FRAME,
): string {
  const s = withDefaults(DEFAULT_CAPTIONS, settings);
  const scale = captionScale(frame.height);

  const fontSize = Math.max(1, Math.round(s.fontSize * scale));
  const outlineWidth = Math.max(0, round2(s.strokeWidth * scale));

  // BorderStyle 1 outlines the glyphs; 3 fills a box behind the line.
  //
  // The part that is easy to get wrong, and that the preview has to match: in
  // box mode libass fills the box with OutlineColour, NOT BackColour, and
  // reuses Outline as the box's padding. So `strokeColor` is the outline in
  // one mode and the box fill in the other — the UI relabels it to suit, and
  // captionBoxFill() below is what the preview reads so the two cannot drift.
  const borderStyle = s.backdrop === 'box' ? 3 : 1;
  const shadow = s.backdrop === 'shadow' ? round2(3 * scale) : 0;
  // BackColour is only ever the DROP SHADOW's colour. ASS alpha is inverted:
  // 00 is opaque, FF is invisible, so 0x80 is a ~50% scrim.
  const back = hexToAss('#000000', 0x80);

  // Alignment 5 anchors the text block at its CENTRE, which is what makes \pos
  // mean "the point I dragged it to" rather than "one of nine corners".
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${Math.round(frame.width)}
PlayResY: ${Math.round(frame.height)}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.font},${fontSize},${hexToAss(s.color)},${hexToAss(s.highlightColor)},${hexToAss(s.strokeColor)},${back},-1,0,0,0,100,100,0,0,${borderStyle},${outlineWidth},${shadow},5,${CAPTION_MARGIN},${CAPTION_MARGIN},${CAPTION_MARGIN},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const posX = Math.round(s.x * frame.width);
  const posY = Math.round(s.y * frame.height);

  const events = cues.map((cue) => {
    // Karaoke off means one flat line in `color` — no \k, so SecondaryColour
    // never shows and the burn matches a preview that is not animating either.
    const body = s.karaoke
      ? karaokeSpans(cue)
          .map((span) => {
            const cs = karaokeCentiseconds(span.start, span.end);
            return `{\\k${cs}}${assText(span.text, s.allCaps)} `;
          })
          .join('')
          .trim()
      : assText(cue.text, s.allCaps);

    return (
      `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,` +
      `{\\pos(${posX},${posY})}${body}`
    );
  });

  return `${header}\n${events.join('\n')}\n`;
}

/**
 * Escape text for an ASS event.
 *
 * A literal { or } opens an override block and everything to the next } is
 * silently swallowed — so a caption reading "{thing}" would vanish from the
 * burn with no error anywhere.
 */
function assText(text: string, allCaps: boolean): string {
  const out = allCaps ? text.toUpperCase() : text;
  return out
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    // A hard newline in a word would end the Dialogue line early.
    .replace(/\r?\n/g, ' ');
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Hold each word's highlight until the next one starts, so there is no flicker. */
function sourceGap(word: Word, next: Word): number {
  return Math.min(next.start, word.end + 0.3);
}

function srtTime(seconds: number): string {
  return clockTime(seconds, ',');
}

function vttTime(seconds: number): string {
  return clockTime(seconds, '.');
}

function clockTime(seconds: number, decimalMark: string): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);
  return (
    `${pad(h)}:${pad(m)}:${pad(s)}${decimalMark}${String(ms).padStart(3, '0')}`
  );
}

/** ASS uses h:mm:ss.cc with centiseconds and a single-digit hour. */
function assTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const cs = Math.round((seconds % 1) * 100);
  return `${h}:${pad(m)}:${pad(s)}.${String(cs).padStart(2, '0')}`;
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}
