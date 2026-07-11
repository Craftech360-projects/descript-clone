import type { Transcript, Word } from './types.ts';

/**
 * Standalone hesitation sounds. These carry no meaning in any context, so
 * removing them is always safe.
 */
const HESITATIONS = new Set([
  'um', 'umm', 'ummm', 'uh', 'uhh', 'uhhh', 'er', 'err', 'erm',
  'ah', 'ahh', 'eh', 'hmm', 'hm', 'mm', 'mhm', 'uhm',
]);

/**
 * Discourse markers. DANGEROUS to remove blindly: "like" is a filler in
 * "it was, like, huge" but load-bearing in "I like it" and "cities like Paris".
 * Off by default; the UI should surface these as suggestions a human confirms,
 * never as an automatic cut.
 */
const DISCOURSE_PHRASES: string[][] = [
  ['you', 'know'],
  ['i', 'mean'],
  ['sort', 'of'],
  ['kind', 'of'],
];

export interface FillerOptions {
  /** Also flag discourse markers ("you know", "I mean"). Default false. */
  includeDiscourseMarkers?: boolean;
}

/**
 * Tag filler words in place and return how many were found.
 *
 * IMPORTANT: this only works on a VERBATIM transcript. Standard ASR (Whisper,
 * Parakeet) normalizes its output and silently drops most "um"/"uh" before you
 * ever see them — so on a normalized transcript this will correctly find almost
 * nothing, and that is not a bug in this function. Verbatim ASR is a hard
 * requirement for the feature, not a nice-to-have.
 */
export function detectFillers(transcript: Transcript, options: FillerOptions = {}): number {
  const words = transcript.words;
  let found = 0;

  for (const word of words) word.isFiller = false;

  for (let i = 0; i < words.length; i++) {
    if (HESITATIONS.has(normalize(words[i].text))) {
      words[i].isFiller = true;
      found++;
    }
  }

  if (options.includeDiscourseMarkers) {
    for (const phrase of DISCOURSE_PHRASES) {
      for (let i = 0; i + phrase.length <= words.length; i++) {
        const matches = phrase.every((p, k) => normalize(words[i + k].text) === p);
        if (matches) {
          for (let k = 0; k < phrase.length; k++) {
            if (!words[i + k].isFiller) {
              words[i + k].isFiller = true;
              found++;
            }
          }
        }
      }
    }
  }

  return found;
}

/** Mark every tagged filler as deleted. Reversible: the words stay in the doc. */
export function removeFillers(transcript: Transcript): number {
  let removed = 0;
  for (const word of transcript.words) {
    if (word.isFiller && !word.deleted) {
      word.deleted = true;
      removed++;
    }
  }
  return removed;
}

export function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z']/g, '');
}

export function isHesitation(word: Word): boolean {
  return HESITATIONS.has(normalize(word.text));
}
