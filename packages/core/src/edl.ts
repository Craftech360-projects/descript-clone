import {
  DEFAULT_COMPILE_OPTIONS,
  type CompileOptions,
  type Edl,
  type EdlClip,
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
  return {
    sourceDuration: transcript.duration,
    keep: compileClipRanges(transcript.words, transcript.duration, opts),
    fadeMs: opts.fadeMs,
  };
}

/** One clip's contribution to a sequence: its file duration and its words. */
export interface SequenceClip {
  clipId: string;
  duration: number;
  words: Word[];
}

/**
 * Compile a whole sequence of clips into one EDL on a single global timeline.
 *
 * Each clip is compiled exactly as compileEdl would compile it alone — its own
 * pauses, deletions, padding, and merges, bounded by its own duration — and then
 * its ranges are shifted by the clip's global offset and concatenated in play
 * order. Ranges are never merged ACROSS a clip boundary: two clips are two files
 * and the seam between them is a real cut, not a splice. The single-clip case is
 * identical to compileEdl (offset 0), plus the `clips` metadata the render and
 * playback need to map a global range back to a file.
 */
export function compileSequenceEdl(clips: SequenceClip[], options: CompileOptions = {}): Edl {
  const opts = { ...DEFAULT_COMPILE_OPTIONS, ...options };
  const keep: Range[] = [];
  const meta: EdlClip[] = [];
  let offset = 0;

  for (const clip of clips) {
    const local = compileClipRanges(clip.words, clip.duration, opts);
    for (const r of local) keep.push({ start: r.start + offset, end: r.end + offset });
    meta.push({ clipId: clip.clipId, offset, sourceDuration: clip.duration });
    offset += clip.duration;
  }

  return { sourceDuration: offset, keep, fadeMs: opts.fadeMs, clips: meta };
}

/**
 * The keep-ranges for a single clip's words, in that clip's own timeline.
 *
 * This is the heart of compileEdl, lifted out so a sequence can run it per clip.
 * `duration` bounds the padding, so it must be the clip's OWN source duration.
 */
function compileClipRanges(words: Word[], duration: number, opts: Required<CompileOptions>): Range[] {
  const pad = opts.padMs / 1000;
  const maxGap = opts.maxGapMs / 1000;
  const mergeWithin = opts.mergeWithinMs / 1000;
  const minTrim = opts.minTrimMs / 1000;

  // Keep original indices: a break in index continuity means a word was deleted
  // between two survivors, which forces a cut. A merely-long pause does not.
  const kept: Array<{ word: Word; index: number }> = [];
  words.forEach((word, index) => {
    if (!word.deleted) kept.push({ word, index });
  });

  if (kept.length === 0) {
    /**
     * Nothing survives — but there are two very different reasons for that, and
     * conflating them threw away footage.
     *
     * A clip that NEVER HAD WORDS is a time-lapse, a slow-mo, a silent B-roll
     * shot: material deliberately imported, which nobody happened to speak over.
     * Silence is not an edit, and dropping it because the transcript is empty
     * made those clips vanish from the timeline AND from the export. Keep the
     * whole thing; it is the user's footage until they say otherwise.
     *
     * A clip whose words were all DELETED is the opposite: that IS an edit, made
     * deliberately, and it must stay gone. The two are told apart by whether any
     * words exist at all, which is the only signal that distinguishes them.
     */
    return words.length === 0 ? [{ start: 0, end: duration }] : [];
  }

  /**
   * "Keep every pause" means keep the WHOLE clip, not just its talking.
   *
   * Building ranges from the kept WORDS meant a clip survived only between its
   * first and last recognised word. That is fine when the recogniser heard
   * everything; it is data loss when it did not. On a real clip: 99.5 seconds
   * long, words only between 39.4s and 64.3s because the people either side
   * were speaking Chinese and an English recogniser returned nothing — so 75
   * seconds of footage were dropped, and it looked like the editor was randomly
   * skipping. The recogniser's vocabulary is not a licence to delete video.
   *
   * So with no pause cap the clip is kept whole and only DELETED words are
   * removed from it. That is the honest reading of the setting, and it makes
   * cutting something you do rather than something done to you: the timeline
   * holds everything you imported until you take a word out of it.
   *
   * With a cap set, the tightening logic below still runs — that is a request
   * to shorten, and shortening is what it does.
   */
  if (!Number.isFinite(maxGap)) {
    const cuts = mergeAdjacent(
      words
        .filter((w) => w.deleted)
        .map((w) => ({ start: clamp(w.start, 0, duration), end: clamp(w.end, 0, duration) })),
      mergeWithin,
    );
    const out: Range[] = [];
    let cursor = 0;
    for (const cut of cuts) {
      if (cut.start > cursor) out.push({ start: cursor, end: cut.start });
      cursor = Math.max(cursor, cut.end);
    }
    if (cursor < duration) out.push({ start: cursor, end: duration });
    // Padded and merged exactly as the tightening path is: pad gives the seam
    // either side of a deletion room to breathe rather than clipping the words
    // that survived, and merging stops a pad that closes a hole from emitting a
    // zero-length cut. Clamped to the clip, so padding never invents footage.
    const padded = out.map((r) => ({
      start: clamp(r.start - pad, 0, duration),
      end: clamp(r.end + pad, 0, duration),
    }));
    return mergeAdjacent(padded, mergeWithin).filter((r) => r.end - r.start > minTrim);
  }

  const raw: Range[] = [];
  /**
   * The clip's own start, not its first word.
   *
   * A pause cap is a request to shorten dead air BETWEEN words. It was also
   * silently dropping everything before the first word and after the last —
   * which on a clip where the recogniser missed the speech (someone talking in
   * a language it does not have) meant most of the shot. It also made the
   * saving Tighten promises wrong, because countPauses only ever measured the
   * gaps between words and knew nothing of the head and tail it was removing.
   *
   * Head and tail are now always kept, at any cap. What the cap governs is the
   * silence in the middle, which is what it says it does.
   */
  let openStart = 0;

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
  raw.push({ start: openStart, end: duration });

  const padded = raw.map((r) => ({
    start: clamp(r.start - pad, 0, duration),
    end: clamp(r.end + pad, 0, duration),
  }));

  return mergeAdjacent(padded, mergeWithin).filter((r) => r.end > r.start);
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

// ── clips: mapping the global timeline back to individual files ────────────────
//
// A single-source EDL has no `clips` (its one implicit clip spans everything);
// these helpers present it as one clip anyway, so callers never branch on it.

/** The clips this EDL is made of — the real list, or one implicit clip. */
export function edlClips(edl: Edl): EdlClip[] {
  return edl.clips ?? [{ clipId: '', offset: 0, sourceDuration: edl.sourceDuration }];
}

/**
 * Which clip a global timeline time falls in. Each clip owns [offset,
 * offset+sourceDuration); the last clip also owns its exact end so a time at the
 * very tail resolves rather than falling off. Returns null only for a negative
 * time or an empty EDL.
 */
export function clipAt(edl: Edl, globalTime: number): EdlClip | null {
  const clips = edlClips(edl);
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    const isLast = i === clips.length - 1;
    const end = c.offset + c.sourceDuration;
    if (globalTime >= c.offset && (globalTime < end || (isLast && globalTime <= end))) return c;
  }
  return null;
}

/** The clip with this id, or null. */
export function clipById(edl: Edl, clipId: string): EdlClip | null {
  return edlClips(edl).find((c) => c.clipId === clipId) ?? null;
}

/**
 * Split a global keep-range into which clip it belongs to and the local
 * [start,end) in that clip's own file. Because ranges never span a clip boundary
 * (compileSequenceEdl cuts at every seam), the whole range shares one clip: its
 * start decides. Returns null for a range no clip contains (a malformed EDL).
 */
export function localRange(edl: Edl, range: Range): { clip: EdlClip; start: number; end: number } | null {
  const clip = clipAt(edl, range.start);
  if (!clip) return null;
  return { clip, start: range.start - clip.offset, end: range.end - clip.offset };
}
