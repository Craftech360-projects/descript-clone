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
  /**
   * Which source clip this word's [start,end] address. Absent on single-source
   * projects — every word then belongs to the one clip. Once a project holds
   * several clips, each word carries the id of the clip whose file its timings
   * index, so the flat script (all clips' words in one array) can be compiled
   * back into per-clip ranges. See EdlClip and compileSequenceEdl.
   */
  clipId?: string;
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
 * One source clip's placement on the EDL's global timeline.
 *
 * A multi-clip EDL keeps its ranges in ONE continuous "global" timeline —
 * clip 0 occupies [0, dur0), clip 1 [dur0, dur0+dur1), and so on — so every pure
 * mapper (sourceToOutput, playStep, classifyColumns…) keeps working on a single
 * monotonic clock, unchanged. This is the key back: given a global range, its
 * clip is the one whose [offset, offset+sourceDuration) contains its start, and
 * the local time in that clip's own file is `global - offset`. Render and
 * playback use exactly that to pick a file and seek within it.
 */
export interface EdlClip {
  clipId: string;
  /** Where this clip begins on the global timeline: Σ of prior clip durations. */
  offset: number;
  /** This clip's own source-file duration, in seconds. */
  sourceDuration: number;
}

/**
 * An Edit Decision List: the ordered keep-ranges of the source to concatenate.
 * This is the complete, non-destructive description of an edit. The source
 * media is never modified; rendering is a pure function of (source, EDL).
 */
export interface Edl {
  /** Total source length: one file's duration, or the sum across all clips. */
  sourceDuration: number;
  keep: Range[];
  /** Micro-fade at every cut boundary, in ms. Without this, cuts click audibly. */
  fadeMs: number;
  /**
   * The clips this EDL's global timeline is made of, in play order. Absent on a
   * single-source EDL (compileEdl): the whole thing is then one implicit clip and
   * every range's `start` is a plain source timestamp. Present once the EDL spans
   * several clips (compileSequenceEdl), so render/playback can split each global
   * range back to (clip file, local time).
   */
  clips?: EdlClip[];
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
  /**
   * The least silence a PAUSE cut must remove to be worth making, in ms.
   *
   * Applies only to maxGapMs. A deletion is never subject to it: that hole
   * contains a word you asked to lose, and its size is not the point.
   *
   * A cut is not free. In the preview it is a seek, and a seek re-decodes from
   * the previous H.264 keyframe — measured against this app's own media, 116ms
   * at p50 and 215ms at p90, with the file fully buffered, so it is codec cost
   * and not network. In the render it is a dropped range of frames plus a
   * micro-fade each side, i.e. 2*fadeMs of ramp. Trimming 20ms off a 520ms pause spends
   * both to save nothing anyone can hear: at a 500ms cap that described 65 of
   * 175 cuts, each freezing the picture for longer than the silence it removed.
   * A pause you cannot shorten usefully is a pause you leave alone.
   */
  minTrimMs?: number;
  /** Micro-fade length at cut boundaries. */
  fadeMs?: number;
}

export const DEFAULT_COMPILE_OPTIONS: Required<CompileOptions> = {
  padMs: 40,
  maxGapMs: Infinity,
  mergeWithinMs: 20,
  minTrimMs: 250,
  fadeMs: 12,
};
