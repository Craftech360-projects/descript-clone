import { sourceToOutput } from './edl.ts';
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
  const opts = { ...DEFAULTS, ...options };
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

  return cues;
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

/**
 * ASS subtitles for burn-in, with per-word karaoke timing (\k tags) — the
 * animated-caption look. ffmpeg renders these natively via the subtitles filter.
 */
export function toAss(cues: Cue[], style: AssStyle = {}): string {
  const s = { ...ASS_DEFAULTS, ...style };

  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${s.playResX}
PlayResY: ${s.playResY}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${s.font},${s.fontSize},${s.primary},${s.highlight},${s.outline},&H00000000,-1,0,0,0,100,100,0,0,1,${s.outlineWidth},0,2,40,40,${s.marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = cues.map((cue) => {
    // \k is in centiseconds, and colours the word as it is spoken.
    const karaoke = cue.words
      .map((w, i) => {
        const next = cue.words[i + 1];
        const wordEnd = next ? sourceGap(w, next) : w.end;
        const cs = Math.max(1, Math.round((wordEnd - w.start) * 100));
        return `{\\k${cs}}${w.text} `;
      })
      .join('')
      .trim();

    return `Dialogue: 0,${assTime(cue.start)},${assTime(cue.end)},Default,,0,0,0,,${karaoke}`;
  });

  return `${header}\n${events.join('\n')}\n`;
}

/** Hold each word's highlight until the next one starts, so there is no flicker. */
function sourceGap(word: Word, next: Word): number {
  return Math.min(next.start, word.end + 0.3);
}

export interface AssStyle {
  font?: string;
  fontSize?: number;
  /** ASS colours are &HAABBGGRR — note BGR order, not RGB. */
  primary?: string;
  highlight?: string;
  outline?: string;
  outlineWidth?: number;
  marginV?: number;
  playResX?: number;
  playResY?: number;
}

const ASS_DEFAULTS: Required<AssStyle> = {
  font: 'Arial',
  fontSize: 48,
  primary: '&H00FFFFFF',  // white
  highlight: '&H0000D5FF', // amber, as each word is spoken
  outline: '&H00000000',   // black
  outlineWidth: 3,
  marginV: 60,
  playResX: 1920,
  playResY: 1080,
};

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
