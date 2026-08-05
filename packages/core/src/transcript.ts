import type { Word } from './types.ts';

/**
 * The one invariant a stitched multi-clip script has to hold: a word id names
 * exactly one word.
 *
 * ASR numbers words from zero per FILE. Every clip therefore comes back with its
 * own w0, w2, w4… , and concatenating two clips into one script produces two
 * words called `w4`. A word id is the handle EVERYTHING downstream reaches for:
 * selection is a `Set<string>` of ids, `buildWordPatch` matches words by id, the
 * script's index map is keyed by id, and the save route flags deletions by id.
 * So a collision welds the two twins together — clicking a word in clip 1
 * highlights its counterpart in clip 2, a spelling correction rewrites both, and
 * a delete cuts media out of a clip the user never touched.
 *
 * The later copy is renamed by prefixing its own clip id, which is a uuid and so
 * cannot collide with anything. The FIRST copy keeps its id, which is what makes
 * this safe to run everywhere: a script with no repeats (every single-clip
 * project, and every multi-clip project already repaired) comes back as the very
 * same array, object identities intact — no history rewrite, no lost structure
 * sharing, no change on disk. Idempotent for the same reason: a second pass
 * finds no duplicates.
 */
export function uniqueWordIds(words: Word[]): Word[] {
  const seen = new Set<string>();
  let collided = false;

  const out = words.map((word) => {
    if (!seen.has(word.id)) {
      seen.add(word.id);
      return word;
    }

    collided = true;
    // A word with no clipId belongs to the implicit first clip — and the first
    // clip's words are the ones that kept their ids above, so reaching here
    // without a clipId means a hand-edited record. Suffix it rather than give up.
    const base = word.clipId ? `${word.clipId}:${word.id}` : `${word.id}-dup`;
    let id = base;
    for (let n = 2; seen.has(id); n++) id = `${base}#${n}`;
    seen.add(id);
    return { ...word, id };
  });

  return collided ? out : words;
}
