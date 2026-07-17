import type { Transcript, Word } from './types.ts';

/**
 * A block of script attributed to one speaker — the unit Descript's document is
 * built from. The speaker name sits in the margin and the words flow beside it,
 * so the script reads like an interview transcript rather than a wall of text.
 */
export interface Paragraph {
  speaker?: string;
  words: Word[];
  start: number;
  end: number;
}

export interface ParagraphOptions {
  /**
   * A pause this long starts a new block even for the same speaker — it is where
   * a human would put a paragraph break. Descript does the same thing.
   */
  breakOnPauseMs?: number;
  /** Force a break past this many words, so a monologue is still readable. */
  maxWords?: number;
}

const DEFAULTS: Required<ParagraphOptions> = {
  breakOnPauseMs: 700,
  maxWords: 80,
};

/**
 * Group words into speaker blocks. Breaks on: speaker change, a long pause, or
 * an over-long block.
 *
 * Deleted words stay in their block — they are struck through in place, not
 * removed, so every cut stays visible and reversible.
 */
export function toParagraphs(transcript: Transcript, options: ParagraphOptions = {}): Paragraph[] {
  const opts = { ...DEFAULTS, ...options };
  const breakOnPause = opts.breakOnPauseMs / 1000;
  const paragraphs: Paragraph[] = [];

  let current: Word[] = [];
  let currentSpeaker: string | undefined;

  const flush = () => {
    if (current.length === 0) return;
    paragraphs.push({
      speaker: currentSpeaker,
      words: current,
      start: current[0].start,
      end: current[current.length - 1].end,
    });
    current = [];
  };

  for (const word of transcript.words) {
    const previous = current[current.length - 1];

    const speakerChanged = current.length > 0 && word.speaker !== currentSpeaker;
    const longPause = previous ? word.start - previous.end >= breakOnPause : false;
    const tooLong = current.length >= opts.maxWords;

    if (speakerChanged || longPause || tooLong) flush();

    if (current.length === 0) currentSpeaker = word.speaker;
    current.push(word);
  }
  flush();

  return paragraphs;
}

/**
 * The word playing at a given source time, for karaoke highlighting.
 * Returns the index into transcript.words, or -1 inside a pause.
 *
 * This used to scan linearly, with a comment inviting a binary search "if this
 * ever shows up in a profile". It does: at the end of a 2282-word transcript the
 * scan ran all 2282 entries, and it is called once per animation frame. Words
 * are sorted by start, so a bisect costs ~11 comparisons instead — 200x fewer,
 * and the cost stops growing as the playhead moves right.
 */
export function wordAt(words: Word[], sourceTime: number): number {
  const i = lastStartingAtOrBefore(words, sourceTime);
  if (i === -1) return -1;
  // Only the nearest word can contain the time; anything earlier ended sooner.
  return sourceTime < words[i].end ? i : -1;
}

/**
 * Index of the last word whose start is <= sourceTime, or -1 before the first.
 * Also the caret-placement primitive: clicking in a pause should land on the
 * word you just heard, not nowhere.
 */
export function lastStartingAtOrBefore(words: Word[], sourceTime: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= sourceTime) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/** Short label for the speaker margin: "SPEAKER_00" -> "Speaker 1". */
export function speakerLabel(speaker: string | undefined): string {
  if (!speaker) return 'Speaker';
  const match = speaker.match(/(\d+)\s*$/);
  return match ? `Speaker ${Number(match[1]) + 1}` : speaker;
}
