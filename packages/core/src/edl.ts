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
  const minTrim = opts.minTrimMs / 1000;

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
      // Words were removed between these two — cut. Unconditionally: the hole
      // holds speech you asked to lose, so leaving it in is not on the table
      // however small it is. minTrim has no say here.
      raw.push({ start: openStart, end: prev.word.end });
      openStart = cur.word.start;
    } else if (gap > maxGap && trimWorthMaking(gap, maxGap, pad, minTrim)) {
      // Nothing was deleted, but the pause is longer than allowed. Split and
      // drop the middle, leaving half the allowance on each side so the cut
      // lands in silence rather than against a word.
      raw.push({ start: openStart, end: prev.word.end + maxGap / 2 });
      openStart = cur.word.start - maxGap / 2;
    }
    // Otherwise the run continues and the natural pause is preserved — either
    // it is within the cap, or shortening it would not buy enough to pay for
    // the cut. See minTrimMs.
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
 * Would shortening this pause remove enough silence to justify a cut?
 *
 * Note what the padding does: it is added back to BOTH sides afterwards, so a
 * pause of `gap` capped to `maxGap` does not leave `gap - maxGap` of hole — it
 * leaves `gap - maxGap - 2*pad`. That is the only figure that matters, because
 * it is what the seek skips and what the concat drops. Comparing the un-padded
 * saving would green-light cuts that padding has already eaten.
 */
function trimWorthMaking(gap: number, maxGap: number, pad: number, minTrim: number): boolean {
  return gap - maxGap - 2 * pad >= minTrim;
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

/**
 * Duration of the rendered output, in seconds.
 *
 * `speed` divides, because it is the last thing that happens to the render and
 * the only thing here that is not a source timestamp: the kept ranges are spliced
 * at 1x and the result is then played out `speed` times faster. Everything that
 * quotes an output length — the transport clock, the export summary, ffmpeg's
 * progress target — has to divide by exactly this, so it lives here rather than
 * at each of them.
 */
export function outputDuration(edl: Edl, speed = 1): number {
  return edl.keep.reduce((sum, r) => sum + (r.end - r.start), 0) / speed;
}

/**
 * The output timestamps where the render jumps from one source range to the
 * next — i.e. where the picture visibly cuts.
 *
 * Captions read this to tell a seam from a silence. Both look like a gap
 * between two cues, but they are opposite things: a seam is time the editor
 * *removed*, and blanking the caption there stacks a second discontinuity on
 * the jump cut. A silence is time the editor *kept*, and a caption over it
 * would be a caption over nothing.
 */
export function splicePoints(edl: Edl): number[] {
  const out: number[] = [];
  let elapsed = 0;
  for (let i = 0; i < edl.keep.length - 1; i++) {
    elapsed += edl.keep[i].end - edl.keep[i].start;
    out.push(elapsed);
  }
  return out;
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
