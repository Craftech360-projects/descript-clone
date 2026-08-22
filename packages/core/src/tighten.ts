import { detectFillers, type FillerOptions } from './fillers.ts';
import { detectRetakes } from './retakes.ts';
import { DEFAULT_COMPILE_OPTIONS, type CompileOptions, type Word } from './types.ts';

/**
 * "Tighten for reels": the three sweeps that are always wanted together,
 * planned as ONE thing.
 *
 * Cutting fillers, cutting false starts and capping pauses are three controls
 * in two sections of the rail, and shipping a reel means driving all three
 * every single time. They are one decision, so this plans them as one.
 *
 * Planning is deliberately separate from doing, for two reasons that both earn
 * their keep:
 *
 * 1. The preview. The panel has to be able to say "24 filler words, 3 false
 *    starts, 61 pauses" BEFORE a word is cut, and it can only do that if the
 *    plan is a value it can hold and show. The same plan is what the store then
 *    applies, so what you were shown is what happens.
 *
 * 2. ORDER. The three steps are not independent. Deleting a word between two
 *    survivors turns the silence around it into an unconditional cut rather
 *    than a shortenable pause — compileEdl splits on a break in index
 *    continuity before it ever looks at maxGapMs — so counting pauses against
 *    the un-swept transcript over-reports every gap the sweep is about to
 *    claim. The pause count here is therefore taken against the words that
 *    survive this plan's OWN cuts. That is the same ordering constraint the
 *    on-import chain documents, and it holds for the same reason.
 *
 * Pure and dependency-free, like every other decision module in here, so the
 * counts the UI promises are testable under `node --test` with no media and no
 * browser.
 */

/**
 * The pause cap "tighten" moves to, in ms.
 *
 * Read it against the compiler's arithmetic rather than as a taste judgement: a
 * gap is only shortened when `gap - maxGap - 2*padMs >= minTrimMs`, so at the
 * default pad of 40ms and min-trim of 250ms this cap leaves every pause under
 * 480ms exactly as recorded and takes the rest down to a beat you can still
 * hear. A cap near 0 would close the joins between sentences into one
 * breathless run; much above this and it stops touching the one-second dead
 * spots that are the whole reason anyone reaches for the control.
 */
export const REEL_PAUSE_MS = 150;

export interface TightenOptions {
  /** Sweep fillers. null leaves them, and any existing flags, alone. */
  fillers: FillerOptions | null;
  /** Sweep false starts. null leaves them alone. */
  retakes: { minWords: number } | null;
  /** The cap to move to, in ms. null leaves the pause setting alone. */
  maxGapMs: number | null;
  /**
   * The cut settings in force right now.
   *
   * All three of maxGapMs, padMs and minTrimMs are read: the first is the cap
   * this plan moves FROM, and the other two are how the compiler decides
   * whether a given pause is worth cutting at all. Passing anything but the
   * live document's own settings makes the pause count a fiction.
   *
   * Partial, and filled from DEFAULT_COMPILE_OPTIONS exactly as compileEdl
   * fills it — not because the document's type says it may be partial (it says
   * Required) but because the WIRE does not keep that promise: the server's
   * EDIT_DEFAULTS carries four fields and minTrimMs is not one of them, so
   * every real doc.cut reaches here without it. Reading it straight would make
   * minTrim NaN, every comparison false, and the pause count a silent zero.
   */
  cut: CompileOptions;
}

export interface TightenPlan {
  /** Ids the filler sweep would cut, in transcript order. */
  fillerIds: string[];
  /**
   * Ids the false-start sweep would cut, in transcript order, EXCLUDING any the
   * filler sweep already claims. A hesitation inside an abandoned take goes
   * either way, and counting it under both headings inflates both numbers.
   */
  retakeIds: string[];
  /** How many false starts those ids came from. */
  retakes: number;
  /** Everything that would be deleted: fillerIds ∪ retakeIds, in order. */
  cutIds: string[];
  /** Pauses the new cap shortens that the old one did not. */
  pauses: number;
  /** Seconds of silence those pauses give up. */
  pausesSec: number;
  /** The cap this plan sets, or null when it leaves the setting alone. */
  maxGapMs: number | null;
  /** The cap in force before it. */
  prevMaxGapMs: number;
  /** True when the cap actually moves — it can move and still shorten nothing. */
  capChanged: boolean;
  /** Nothing in here would change the document. */
  empty: boolean;
}

/**
 * What tightening WOULD do, without doing any of it.
 *
 * `words` is never mutated — detectFillers tags IN PLACE and returns a count,
 * so it is run against a throwaway clone. Letting it touch the live document
 * would rewrite isFiller on every word behind the store's back, with no patch
 * and no undo entry.
 */
export function planTighten(words: Word[], options: TightenOptions): TightenPlan {
  const cut = { ...DEFAULT_COMPILE_OPTIONS, ...options.cut };

  // Hoisted out of the filter below on purpose: the detector is a full pass over
  // the transcript, and calling it per word would turn a linear sweep quadratic.
  const flagged = options.fillers ? flaggedAsFiller(words, options.fillers) : new Set<string>();

  const fillerIds = words.filter((w) => !w.deleted && flagged.has(w.id)).map((w) => w.id);
  const claimed = new Set(fillerIds);

  const retakeIds: string[] = [];
  let retakes = 0;
  if (options.retakes) {
    const ranges = detectRetakes(
      { mediaId: '', duration: 0, words },
      { minWords: options.retakes.minWords },
    );
    for (const range of ranges) {
      let contributed = false;
      for (let i = range.start; i < range.end; i++) {
        const word = words[i];
        if (!word || word.deleted || claimed.has(word.id)) continue;
        claimed.add(word.id);
        retakeIds.push(word.id);
        contributed = true;
      }
      // A range whose every word is already gone is not a false start this
      // action removes — it is one an earlier sweep removed. detectRetakes
      // matches text and knows nothing about edit state, so without this test
      // tighten would keep reporting the same three false starts forever while
      // cutting nothing.
      if (contributed) retakes++;
    }
  }

  const prevMaxGapMs = cut.maxGapMs;
  // Tighten never LOOSENS. Someone who has already dragged the cap below the
  // reel value chose a tighter edit than this action would make; silently
  // undoing that choice is the opposite of what the button says it does.
  const maxGapMs = options.maxGapMs === null ? null : Math.min(options.maxGapMs, prevMaxGapMs);

  const pauses =
    maxGapMs === null ? { count: 0, seconds: 0 } : countPauses(words, claimed, maxGapMs, cut);

  const capChanged = maxGapMs !== null && maxGapMs !== prevMaxGapMs;

  return {
    fillerIds,
    retakeIds,
    retakes,
    // Rebuilt from the word order rather than concatenated, so the ids read in
    // the order they are spoken however they were claimed.
    cutIds: words.filter((w) => claimed.has(w.id)).map((w) => w.id),
    pauses: pauses.count,
    pausesSec: pauses.seconds,
    maxGapMs,
    prevMaxGapMs,
    capChanged,
    empty: claimed.size === 0 && !capChanged,
  };
}

/** Which ids the filler detector flags. Runs on a clone — see planTighten. */
function flaggedAsFiller(words: Word[], options: FillerOptions): Set<string> {
  const scratch = { mediaId: '', duration: 0, words: words.map((w) => ({ ...w })) };
  detectFillers(scratch, options);
  return new Set(scratch.words.filter((w) => w.isFiller).map((w) => w.id));
}

/**
 * Silence one gap gives up at a given cap, in seconds. 0 when the cap does not
 * bite, or when the trim is too small to be worth the cut.
 *
 * Mirrors compileClipRanges, including the part that catches people out: the
 * padding is added back to BOTH sides of the split, so a gap capped at `maxGap`
 * does not lose `gap - maxGap`, it loses `gap - maxGap - 2*pad`. That is also
 * the figure minTrimMs is measured against, so a trim the compiler declines to
 * make must not be counted here either — otherwise the preview promises seconds
 * the render never removes.
 */
function trimAt(gap: number, maxGap: number, pad: number, minTrim: number): number {
  if (!(gap > maxGap)) return 0;
  const saving = gap - maxGap - 2 * pad;
  return saving >= minTrim ? saving : 0;
}

/**
 * How many pauses the new cap shortens that the old one did not, and by how much.
 *
 * A DELTA against the cap already in force, not an absolute count. Tighten run
 * twice must report "shortened 61 pauses" once and nothing the second time; an
 * absolute count would claim the same 61 again while changing not one frame.
 */
function countPauses(
  words: Word[],
  alsoDeleted: Set<string>,
  maxGapMs: number,
  cut: Required<CompileOptions>,
): { count: number; seconds: number } {
  const pad = cut.padMs / 1000;
  const minTrim = cut.minTrimMs / 1000;
  const next = maxGapMs / 1000;
  const prev = cut.maxGapMs / 1000;

  let count = 0;
  let seconds = 0;
  let before: Word | null = null;
  let beforeIndex = -1;

  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word.deleted || alsoDeleted.has(word.id)) continue;

    const prevWord = before;
    const prevIndex = beforeIndex;
    before = word;
    beforeIndex = index;
    if (!prevWord) continue;

    // Adjacent in the ORIGINAL array: a break means a word was deleted between
    // these two, and the compiler cuts there unconditionally — that hole is a
    // deletion, not a pause, and maxGapMs never gets a say in it.
    if (index !== prevIndex + 1) continue;
    // A clip seam is two files, not a silence. compileSequenceEdl compiles each
    // clip on its own timeline, so a "gap" across the join is not a gap at all —
    // the two timestamps address different files.
    if ((prevWord.clipId ?? '') !== (word.clipId ?? '')) continue;

    const gap = word.start - prevWord.end;
    const gain = trimAt(gap, next, pad, minTrim) - trimAt(gap, prev, pad, minTrim);
    if (gain > 0) {
      count++;
      seconds += gain;
    }
  }

  return { count, seconds };
}

/**
 * The plan as lines to show BEFORE it runs — one per step that would do
 * something, in the order the sweep applies them.
 *
 * Steps that would change nothing are absent rather than present and reading
 * "0". A preview is a list of what is about to happen; padding it with
 * non-events makes the reader work out which lines matter.
 */
export function previewTighten(plan: TightenPlan): string[] {
  const lines: string[] = [];
  if (plan.fillerIds.length > 0) lines.push(`Cut ${plural(plan.fillerIds.length, 'filler word')}`);
  if (plan.retakes > 0) {
    lines.push(
      `Cut ${plural(plan.retakes, 'false start')} — ${plural(plan.retakeIds.length, 'more word')}`,
    );
  }
  if (plan.pauses > 0) {
    lines.push(
      `Shorten ${plural(plan.pauses, 'pause')} to ${plan.maxGapMs}ms — ${seconds(plan.pausesSec)} of silence`,
    );
  } else if (plan.capChanged) {
    // Honest about the one case that would otherwise look like a bug: the cap
    // moves, and no pause in this script is long enough for the compiler to
    // touch. Saying so beats a preview that lists nothing and then reports work.
    lines.push(`Cap pauses at ${plan.maxGapMs}ms — none in this script are long enough to shorten`);
  }
  return lines;
}

/** What it DID, in one sentence, for the notice afterwards. */
export function reportTighten(plan: TightenPlan): string {
  const parts: string[] = [];
  if (plan.fillerIds.length > 0) parts.push(`removed ${plural(plan.fillerIds.length, 'filler word')}`);
  if (plan.retakes > 0) parts.push(`removed ${plural(plan.retakes, 'false start')}`);
  if (plan.pauses > 0) parts.push(`shortened ${plural(plan.pauses, 'pause')}`);
  else if (plan.capChanged) parts.push(`capped pauses at ${plan.maxGapMs}ms`);
  if (parts.length === 0) return 'Nothing to tighten — this script is already clean.';
  return `Tightened: ${list(parts)}.`;
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "a, b and c" — the last join is "and", because this is a sentence. */
function list(parts: string[]): string {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** Seconds at one decimal, or minutes and seconds once it passes a minute. */
function seconds(value: number): string {
  if (value < 60) return `${value.toFixed(1)}s`;
  const mins = Math.floor(value / 60);
  return `${mins}m ${Math.round(value - mins * 60)}s`;
}
