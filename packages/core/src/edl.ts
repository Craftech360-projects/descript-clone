import {
  DEFAULT_COMPILE_OPTIONS,
  type CompileOptions,
  type Edl,
  type Range,
  type Transcript,
  type Word,
} from './types.ts';

/**
 * Compile a transcript's edit state into an Edit Decision List.
 *
 * This is the core of text-based editing: deleting words in the transcript is
 * a range subtraction over the source timeline. The compiler is a pure function
 * — same transcript in, same EDL out — which is what keeps the edit
 * non-destructive and makes the whole thing testable without any media.
 *
 * Note: the EDL is word-bounded. Silence before the first word and after the
 * last is trimmed, so "no deletions" is not byte-identical to the source.
 * That is deliberate (it is free top-and-tail trimming), not an oversight.
 */
export function compileEdl(transcript: Transcript, options: CompileOptions = {}): Edl {
  const opts = { ...DEFAULT_COMPILE_OPTIONS, ...options };
  const pad = opts.padMs / 1000;
  const maxGap = opts.maxGapMs / 1000;
  const mergeWithin = opts.mergeWithinMs / 1000;

  // Keep original indices: a break in index continuity means a word was deleted
  // between two survivors, which forces a cut. A merely-long pause does not.
  const kept: Array<{ word: Word; index: number }> = [];
  transcript.words.forEach((word, index) => {
    if (!word.deleted) kept.push({ word, index });
  });

  if (kept.length === 0) {
    return { sourceDuration: transcript.duration, keep: [], fadeMs: opts.fadeMs };
  }

  const raw: Range[] = [];
  let openStart = kept[0].word.start;

  for (let i = 1; i < kept.length; i++) {
    const prev = kept[i - 1];
    const cur = kept[i];

    const contiguous = cur.index === prev.index + 1;
    const gap = cur.word.start - prev.word.end;

    if (!contiguous) {
      // Words were removed between these two — cut.
      raw.push({ start: openStart, end: prev.word.end });
      openStart = cur.word.start;
    } else if (gap > maxGap) {
      // Nothing was deleted, but the pause is longer than allowed. Split and
      // drop the middle, leaving half the allowance on each side so the cut
      // lands in silence rather than against a word.
      raw.push({ start: openStart, end: prev.word.end + maxGap / 2 });
      openStart = cur.word.start - maxGap / 2;
    }
    // Otherwise the run continues and the natural pause is preserved.
  }
  raw.push({ start: openStart, end: kept[kept.length - 1].word.end });

  const padded = raw.map((r) => ({
    start: clamp(r.start - pad, 0, transcript.duration),
    end: clamp(r.end + pad, 0, transcript.duration),
  }));

  return {
    sourceDuration: transcript.duration,
    keep: mergeAdjacent(padded, mergeWithin).filter((r) => r.end > r.start),
    fadeMs: opts.fadeMs,
  };
}

/**
 * Merge only *consecutive* ranges, never globally sorted, because keep[] order
 * is output order — that is what will let paragraph reordering work later
 * without rewriting the compiler.
 */
function mergeAdjacent(ranges: Range[], mergeWithin: number): Range[] {
  const out: Range[] = [];
  for (const r of ranges) {
    const last = out[out.length - 1];
    const contiguousInSource = last && r.start >= last.start && r.start <= last.end + mergeWithin;
    if (contiguousInSource) {
      last.end = Math.max(last.end, r.end);
    } else {
      out.push({ ...r });
    }
  }
  return out;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Duration of the rendered output, in seconds. */
export function outputDuration(edl: Edl): number {
  return edl.keep.reduce((sum, r) => sum + (r.end - r.start), 0);
}

/**
 * Map a source timestamp to its position in the rendered output.
 * Returns null if that moment was cut. Needed to drive the playhead and to
 * re-time captions against the edited render.
 */
export function sourceToOutput(edl: Edl, sourceTime: number): number | null {
  let elapsed = 0;
  for (const r of edl.keep) {
    if (sourceTime >= r.start && sourceTime < r.end) return elapsed + (sourceTime - r.start);
    elapsed += r.end - r.start;
  }
  return null;
}

/** Inverse of sourceToOutput: where in the source is this moment of the render? */
export function outputToSource(edl: Edl, outputTime: number): number | null {
  let elapsed = 0;
  for (const r of edl.keep) {
    const len = r.end - r.start;
    if (outputTime < elapsed + len) return r.start + (outputTime - elapsed);
    elapsed += len;
  }
  return null;
}
