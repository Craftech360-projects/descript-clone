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
 */
export function wordAt(words: Word[], sourceTime: number): number {
  // Linear is fine at podcast scale (tens of thousands of words, 60fps). Swap for
  // a binary search if this ever shows up in a profile.
  for (let i = 0; i < words.length; i++) {
    if (sourceTime >= words[i].start && sourceTime < words[i].end) return i;
    if (words[i].start > sourceTime) break;
  }
  return -1;
}

/** Short label for the speaker margin: "SPEAKER_00" -> "Speaker 1". */
export function speakerLabel(speaker: string | undefined): string {
  if (!speaker) return 'Speaker';
  const match = speaker.match(/(\d+)\s*$/);
  return match ? `Speaker ${Number(match[1]) + 1}` : speaker;
}
