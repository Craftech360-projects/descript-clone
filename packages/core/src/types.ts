/**
 * The transcript document is the single source of truth for the editor.
 * Every word carries its own [start, end] in the SOURCE media timeline —
 * that is what makes text edits compilable into media edits.
 */

export interface Word {
  /** Stable id, survives reordering. */
  id: string;
  /** Display text, no surrounding whitespace. */
  text: string;
  /** Seconds into the source media. */
  start: number;
  end: number;
  /** Diarization label, e.g. "SPEAKER_00". Optional: the editor works without it. */
  speaker?: string;
  /** Soft delete. Deleted words stay in the doc so edits are reversible. */
  deleted?: boolean;
  /** Tagged by the filler detector; lets the UI dim them and offer one-click removal. */
  isFiller?: boolean;
}

export interface Transcript {
  mediaId: string;
  /** Source media duration in seconds. */
  duration: number;
  words: Word[];
}

/** A half-open interval [start, end) in the source timeline, in seconds. */
export interface Range {
  start: number;
  end: number;
}

/**
 * An Edit Decision List: the ordered keep-ranges of the source to concatenate.
 * This is the complete, non-destructive description of an edit. The source
 * media is never modified; rendering is a pure function of (source, EDL).
 */
export interface Edl {
  sourceDuration: number;
  keep: Range[];
  /** Micro-fade at every cut boundary, in ms. Without this, cuts click audibly. */
  fadeMs: number;
}

export interface CompileOptions {
  /**
   * Padding added around each kept run, in ms. ASR word boundaries land on the
   * onset of phonation; without a little padding, cuts clip plosives and sound
   * chopped.
   */
  padMs?: number;
  /**
   * Cap on silence BETWEEN kept words, in ms. This is what "shorten word gaps"
   * compiles to — a long pause becomes a split with the middle removed.
   * Set to Infinity to keep all pauses intact.
   */
  maxGapMs?: number;
  /** Ranges closer together than this get merged rather than producing a cut. */
  mergeWithinMs?: number;
  /** Micro-fade length at cut boundaries. */
  fadeMs?: number;
}

export const DEFAULT_COMPILE_OPTIONS: Required<CompileOptions> = {
  padMs: 40,
  maxGapMs: Infinity,
  mergeWithinMs: 20,
  fadeMs: 12,
};
