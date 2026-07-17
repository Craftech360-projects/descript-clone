import type { Transcript, Word } from './types.ts';

/**
 * Standalone hesitation sounds. These carry no meaning in any context, so
 * removing them is always safe.
 *
 * Matched by shape, not by a fixed list. A verbatim model spells a hesitation
 * as long as the speaker held it — "um", "umm", "ummmm", "uhhhhh" — and any
 * finite list quietly misses the long tail (the old list stopped at three
 * letters, so a four-m "ummmm" read as an ordinary word and survived the cut).
 *
 * Each alternative is anchored and made only of vowel/nasal runs, so none can
 * reach a real English word. The one deliberate exception is "err": a rare verb
 * ("to err is human") that is overwhelmingly the filler in speech. That was the
 * previous behaviour too, so this does not widen the blast radius.
 */
const HESITATION = new RegExp(
  '^(?:' +
    [
      'u+m+', // um, umm, ummmm
      'u+h+', // uh, uhh, uhhhh
      'u+h+m+', // uhm, uhmm
      'h+m+', // hm, hmm, hmmm
      'm+h+m+', // mhm, mmhmm — backchannel
      'mm+', // mm, mmm
      'e+r+m*', // er, err, erm, ermm
      'e+h+', // eh, ehh
      'a+h+', // ah, ahh, aah
    ].join('|') +
    ')$',
);

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
    if (HESITATION.test(normalize(words[i].text))) {
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
  return HESITATION.test(normalize(word.text));
}
