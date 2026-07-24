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
 * The stalling "So" that opens an utterance — "So, I was thinking…", "So we
 * shipped it." Treated as a hesitation by default, because in that position it
 * is one: the speaker is buying a beat before the sentence starts, and the
 * sentence reads the same without it.
 *
 * Unlike everything in HESITATION, "so" IS a real word, so shape alone cannot
 * decide it — position does. Only an utterance-initial "so" qualifies: the first
 * word, one after a sentence-ending mark, or one after a pause long enough to be
 * a fresh start. Mid-sentence "so" ("it was so big", "so that it works") is
 * never touched.
 */
const SO_PAUSE_MS = 350;

/**
 * Words that make a leading "So" load-bearing rather than a stall: the degree
 * modifier. "So much for that" without its "so" is broken English, where "So we
 * left" without it is not. Cheap guard on the one case where position is not
 * enough.
 */
const SO_KEEPERS = new Set(['much', 'many', 'far', 'long', 'few', 'little']);

/** Is words[i] a stalling, utterance-initial "so"? See SO_PAUSE_MS. */
function isLeadingSo(words: Word[], i: number): boolean {
  if (normalize(words[i].text) !== 'so') return false;
  if (SO_KEEPERS.has(normalize(words[i + 1]?.text ?? ''))) return false;

  const prev = words[i - 1];
  if (!prev) return true; // opens the transcript
  if (/[.!?…]["')\]]*$/.test(prev.text.trim())) return true; // opens a sentence
  return (words[i].start - prev.end) * 1000 >= SO_PAUSE_MS; // opens after a beat
}

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

  /**
   * Extra words the user wants treated as fillers — e.g. "basically",
   * "literally", "actually", or a personal verbal tic the shape-matcher above
   * can't know about. Matched exactly (after normalize) against single words,
   * so an entry only ever catches the word itself, never a substring of a
   * longer one. Blank entries are ignored.
   */
  customWords?: string[];
}

/**
 * Tag filler words in place and return how many were found.
 *
 * IMPORTANT: this only works on a VERBATIM transcript. Standard ASR (Whisper,
 * Parakeet) normalizes its output and silently drops most "um"/"uh" before you
 * ever see them — so on a normalized transcript this will correctly find almost
 * nothing, and that is not a bug in this function. Verbatim ASR is a hard
 * requirement for the feature, not a nice-to-have. The one exception is the
 * leading "so" — a real word, so every model transcribes it either way.
 */
export function detectFillers(transcript: Transcript, options: FillerOptions = {}): number {
  const words = transcript.words;
  let found = 0;

  // User-defined fillers, normalized to match how words are compared below.
  // A Set makes the per-word check O(1) no matter how long the list grows.
  const custom = new Set((options.customWords ?? []).map(normalize).filter(Boolean));

  for (const word of words) word.isFiller = false;

  for (let i = 0; i < words.length; i++) {
    const n = normalize(words[i].text);
    if (HESITATION.test(n) || custom.has(n) || isLeadingSo(words, i)) {
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
