import { speakerLabel } from '../../../packages/core/src/paragraphs.ts';
import type { Word } from '../../../packages/core/src/types.ts';

/**
 * Who is talking, and in what colour.
 *
 * `--spk-1` … `--spk-8` have been sitting in tokens.css since it was written,
 * referenced by nothing — planned and then abandoned, exactly like the orphan
 * `kbd` class. They are the only colour in this app that carries meaning rather
 * than decoration, and the meaning is already in the data: every Word may carry
 * a `speaker`.
 *
 * Colour is assigned by ORDER OF FIRST APPEARANCE, not by hashing the label.
 * A hash would be stable across sessions but arbitrary within one — the main
 * speaker could draw #7 and read as an afterthought. First-appearance ordering
 * means the person who opens the piece is always --spk-1, which is the one
 * assignment a viewer can predict.
 */

export interface Speaker {
  /** The raw value from the transcript; undefined when the ASR gave none. */
  id: string | undefined;
  label: string;
  /** A `var(--spk-N)` reference, not a hex — the theme stays in tokens.css. */
  color: string;
  words: number;
  /** Where they first speak, so the list can seek. */
  start: number;
}

const RAMP = 8;

export function speakers(words: Word[]): Speaker[] {
  const byId = new Map<string | undefined, Speaker>();

  for (const word of words) {
    const existing = byId.get(word.speaker);
    if (existing) {
      existing.words++;
      continue;
    }
    byId.set(word.speaker, {
      id: word.speaker,
      label: speakerLabel(word.speaker),
      // Map wraps past 8 rather than running out. Two speakers sharing a colour
      // in a 9-speaker piece is survivable; `undefined` is not.
      color: `var(--spk-${(byId.size % RAMP) + 1})`,
      words: 1,
      start: word.start,
    });
  }

  return [...byId.values()];
}

/** Speaker → colour, for the script margin. Built once per transcript. */
export function colorMap(list: Speaker[]): Map<string | undefined, string> {
  return new Map(list.map((s) => [s.id, s.color]));
}
