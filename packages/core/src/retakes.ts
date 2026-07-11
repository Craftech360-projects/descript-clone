import { normalize } from './fillers.ts';
import type { Transcript } from './types.ts';

export interface RetakeOptions {
  /** Shortest repeated run to treat as a retake. Below 2, false positives explode. */
  minWords?: number;
  /** Longest run to search for. */
  maxWords?: number;
  /**
   * Words tolerated between the two takes — covers "I want to, uh, I want to".
   * Keep small: a large window starts matching ordinary repetition in prose.
   */
  maxInterruption?: number;
}

const DEFAULTS: Required<RetakeOptions> = {
  minWords: 2,
  maxWords: 12,
  maxInterruption: 3,
};

export interface Retake {
  /** Index range of the abandoned take (inclusive start, exclusive end). */
  start: number;
  end: number;
  text: string;
}

/**
 * Find false starts: a phrase spoken, abandoned, and immediately respoken.
 * "I want to— I want to talk about this" → the first "I want to" is a retake.
 *
 * There is no model for this and there doesn't need to be one. It is n-gram
 * matching over the transcript, and it keeps the LAST take because that is the
 * one the speaker committed to.
 *
 * Searches longest-first so "I want to talk" wins over the shorter "I want".
 */
export function detectRetakes(transcript: Transcript, options: RetakeOptions = {}): Retake[] {
  const opts = { ...DEFAULTS, ...options };
  const words = transcript.words;
  const tokens = words.map((w) => normalize(w.text));

  const retakes: Retake[] = [];
  const claimed = new Set<number>();

  for (let n = opts.maxWords; n >= opts.minWords; n--) {
    for (let i = 0; i + n <= tokens.length; i++) {
      if (overlapsClaimed(i, i + n, claimed)) continue;

      // The second take may start immediately after the first, or after a short
      // interruption ("uh", "sorry", a stumble).
      for (let gap = 0; gap <= opts.maxInterruption; gap++) {
        const j = i + n + gap;
        if (j + n > tokens.length) break;
        if (overlapsClaimed(j, j + n, claimed)) continue;

        const isRepeat = Array.from({ length: n }, (_, k) => k).every(
          (k) => tokens[i + k] !== '' && tokens[i + k] === tokens[j + k],
        );

        if (isRepeat) {
          // Claim the abandoned take AND the interruption between the takes —
          // leaving "uh" stranded between a cut and the good take sounds worse
          // than cutting it too.
          for (let k = i; k < j; k++) claimed.add(k);
          retakes.push({
            start: i,
            end: j,
            text: words.slice(i, j).map((w) => w.text).join(' '),
          });
          break;
        }
      }
    }
  }

  return retakes.sort((a, b) => a.start - b.start);
}

/** Mark detected retakes as deleted, keeping the last take. */
export function removeRetakes(transcript: Transcript, options: RetakeOptions = {}): number {
  const retakes = detectRetakes(transcript, options);
  let removed = 0;
  for (const r of retakes) {
    for (let i = r.start; i < r.end; i++) {
      if (!transcript.words[i].deleted) {
        transcript.words[i].deleted = true;
        removed++;
      }
    }
  }
  return removed;
}

function overlapsClaimed(start: number, end: number, claimed: Set<number>): boolean {
  for (let i = start; i < end; i++) if (claimed.has(i)) return true;
  return false;
}
