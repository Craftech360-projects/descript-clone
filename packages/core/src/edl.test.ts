import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  compileEdl,
  compileSequenceEdl,
  outputDuration,
  sourceToOutput,
  outputToSource,
  splicePoints,
  clipAt,
  localRange,
  type SequenceClip,
} from './edl.ts';
import type { Transcript, Word } from './types.ts';

/** "hello"(0-1) "there"(1-2) "world"(2-3) — one word per second, no pauses. */
function transcript(specs: Array<[string, number, number] | [string, number, number, boolean]>): Transcript {
  const words: Word[] = specs.map(([text, start, end, deleted], i) => ({
    id: `w${i}`,
    text,
    start,
    end,
    deleted: deleted ?? false,
  }));
  return {
    mediaId: 'test',
    duration: Math.max(...words.map((w) => w.end)) + 1,
    words,
  };
}

const NO_PAD = { padMs: 0, mergeWithinMs: 0 };

test('no deletions produces a single word-bounded range', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['there', 1, 2],
    ['world', 2, 3],
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(edl.keep, [{ start: 0, end: 3 }]);
  assert.equal(outputDuration(edl), 3);
});

test('deleting a middle word splits the range and drops its audio', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['umm', 1, 2, true],
    ['world', 2, 3],
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(edl.keep, [
    { start: 0, end: 1 },
    { start: 2, end: 3 },
  ]);
  assert.equal(outputDuration(edl), 2, 'the deleted second is gone from the output');
});

test('a long pause between kept words is preserved by default', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['world', 6, 7], // five seconds of dead air
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(edl.keep, [{ start: 0, end: 7 }], 'no cut: nothing was deleted');
});

test('maxGapMs shortens a long pause, leaving half the allowance each side', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['world', 6, 7],
  ]);
  const edl = compileEdl(t, { ...NO_PAD, maxGapMs: 1000 });
  // Keeps 0.5s after "hello" and 0.5s before "world" — a 1s pause, not 5s.
  assert.deepEqual(edl.keep, [
    { start: 0, end: 1.5 },
    { start: 5.5, end: 7 },
  ]);
  assert.equal(outputDuration(edl), 3);
});

test('a pause is left alone when shortening it would not pay for the cut', () => {
  // A 620ms gap at a 500ms cap. Splitting saves 120ms of silence — and costs a
  // seek that freezes the picture for ~116ms (measured) plus a micro-fade each
  // side. The preview ends up glitchier than if nothing had been cut.
  const t = transcript([
    ['hello', 0, 1],
    ['world', 1.62, 2.5],
  ]);
  const edl = compileEdl(t, { padMs: 40, mergeWithinMs: 20, maxGapMs: 500, minTrimMs: 250 });
  assert.equal(edl.keep.length, 1, 'not worth a cut: leave the pause');
});

test('a pause IS shortened once the saving covers the cut', () => {
  // Same cap, but a 2s gap: 1420ms of dead air comes out after padding. Worth it.
  const t = transcript([
    ['hello', 0, 1],
    ['world', 3, 4],
  ]);
  const edl = compileEdl(t, { padMs: 40, mergeWithinMs: 20, maxGapMs: 500, minTrimMs: 250 });
  assert.equal(edl.keep.length, 2, 'a 2s pause at a 500ms cap must still be cut');
});

test('minTrimMs never spares a deletion, however small the hole', () => {
  // The hole here is 20ms of a word the user deleted. minTrim governs pauses,
  // not deletions: leaving this in would play back a word that was cut.
  const t = transcript([
    ['keep', 0, 1],
    ['um', 1, 1.02, true],
    ['keep', 1.02, 2],
  ]);
  const edl = compileEdl(t, { padMs: 0, mergeWithinMs: 0, maxGapMs: 500, minTrimMs: 250 });
  assert.deepEqual(
    edl.keep,
    [{ start: 0, end: 1 }, { start: 1.02, end: 2 }],
    'a deleted word must be cut regardless of how little time it saves',
  );
});

test('gaps shorter than maxGapMs are left alone', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['world', 1.2, 2],
  ]);
  const edl = compileEdl(t, { ...NO_PAD, maxGapMs: 500 });
  assert.deepEqual(edl.keep, [{ start: 0, end: 2 }], '200ms gap is under the 500ms cap');
});

test('deleting every word yields an empty EDL, not a crash', () => {
  const t = transcript([
    ['hello', 0, 1, true],
    ['world', 1, 2, true],
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(edl.keep, []);
  assert.equal(outputDuration(edl), 0);
});

test('consecutive deletions collapse into one cut, not several', () => {
  const t = transcript([
    ['keep', 0, 1],
    ['cut', 1, 2, true],
    ['cut', 2, 3, true],
    ['cut', 3, 4, true],
    ['keep', 4, 5],
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(edl.keep, [
    { start: 0, end: 1 },
    { start: 4, end: 5 },
  ]);
});

test('padding widens each range and clamps at the media boundaries', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['cut', 1, 2, true],
    ['world', 2, 3],
  ]);
  // duration is 4 (max end + 1), so the tail pad has room but the head does not.
  const edl = compileEdl(t, { padMs: 100, mergeWithinMs: 0 });
  assert.deepEqual(edl.keep, [
    { start: 0, end: 1.1 }, // clamped at 0, cannot go negative
    { start: 1.9, end: 3.1 },
  ]);
});

test('padding that closes a gap merges the ranges instead of emitting a zero-length cut', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['x', 1.0, 1.02, true], // a 20ms deletion
    ['world', 1.02, 2],
  ]);
  const edl = compileEdl(t, { padMs: 40, mergeWithinMs: 20 });
  assert.equal(edl.keep.length, 1, 'the pads overlap, so this is one range, not two');
});

test('splicePoints marks where the picture cuts, on the output timeline', () => {
  // One cut, at the join between the two kept ranges. It must be reported in
  // OUTPUT time — captions use it to tell a seam from a silence, and they are
  // timed on the output.
  const t = transcript([
    ['a', 0, 1],
    ['b', 1, 2, true],
    ['c', 2, 3],
  ]);
  const edl = compileEdl(t, NO_PAD);

  assert.equal(edl.keep.length, 2);
  assert.deepEqual(splicePoints(edl), [1], 'the cut lands 1s into the render');
  assert.equal(splicePoints(edl).length, edl.keep.length - 1);
});

test('an uncut EDL has no splice points', () => {
  const t = transcript([
    ['a', 0, 1],
    ['b', 1, 2],
  ]);
  assert.deepEqual(splicePoints(compileEdl(t, NO_PAD)), []);
});

test('sourceToOutput returns null for cut material and remaps kept material', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['cut', 1, 2, true],
    ['world', 2, 3],
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.equal(sourceToOutput(edl, 0.5), 0.5, 'before the cut: unchanged');
  assert.equal(sourceToOutput(edl, 1.5), null, 'inside the cut: gone');
  assert.equal(sourceToOutput(edl, 2.5), 1.5, 'after the cut: pulled 1s earlier');
});

test('outputToSource inverts sourceToOutput across a cut', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['cut', 1, 2, true],
    ['world', 2, 3],
  ]);
  const edl = compileEdl(t, NO_PAD);
  assert.equal(outputToSource(edl, 1.5), 2.5);
  assert.equal(sourceToOutput(edl, outputToSource(edl, 0.75)!), 0.75);
});

/**
 * A landmine, committed as a skipped test so the next person to reach for word
 * reordering finds it rather than the crater.
 *
 * compileEdl decides where to cut with `cur.index === prev.index + 1`. That test
 * conflates "adjacent in the document" with "adjacent in the source". The two
 * coincide only because word order never changes today. Reorder them and the
 * compiler concludes that consecutive array entries are contiguous audio, merges
 * them into one range, and renders the ORIGINAL order — silently, with no error.
 *
 * The fix is a stable `sourceOrder` on Word, compared instead of the array index.
 * It cannot be a timestamp comparison: the index check is what distinguishes a
 * deletion from a pause (see edl.ts). Note the ids here are non-contiguous
 * (w0, w2, w4) exactly as real ASR output is, so the order cannot be recovered
 * by parsing them either.
 */
test.skip('LANDMINE: reordering words renders the wrong audio', () => {
  const a: Word = { id: 'w0', text: 'A', start: 0, end: 1 };
  const b: Word = { id: 'w2', text: 'B', start: 1, end: 2 };
  const c: Word = { id: 'w4', text: 'C', start: 2, end: 3 };

  // Document order A, C, B — the user moved C before B.
  const reordered: Transcript = { mediaId: 'test', duration: 4, words: [a, c, b] };
  const edl = compileEdl(reordered, NO_PAD);

  // What it SHOULD be: three ranges, in document order, so the render says "A C B".
  assert.deepEqual(
    edl.keep,
    [{ start: 0, end: 1 }, { start: 2, end: 3 }, { start: 1, end: 2 }],
    'each reordered word needs its own range, emitted in document order',
  );

  // What it actually does, verified: every pair is array-adjacent, so the whole
  // thing stays one open run and it emits a SINGLE range from the first word's
  // start to the last word's end — [{0, 2}]. That renders "A B" and drops C
  // entirely. Not merely the wrong order: missing audio, no error.
  assert.notDeepEqual(edl.keep, [{ start: 0, end: 2 }], 'today: one range, C vanishes');
});

// ── multi-clip sequences ───────────────────────────────────────────────────────

/** A clip of one-word-per-second speech, ids and clipId prefixed so they're unique. */
function clip(id: string, specs: Array<[string, number, number] | [string, number, number, boolean]>): SequenceClip {
  const words: Word[] = specs.map(([text, start, end, deleted], i) => ({
    id: `${id}-w${i}`,
    text,
    start,
    end,
    clipId: id,
    deleted: deleted ?? false,
  }));
  return { clipId: id, duration: Math.max(...words.map((w) => w.end)) + 1, words };
}

test('a one-clip sequence matches compileEdl and adds clip metadata', () => {
  const specs: Array<[string, number, number]> = [['a', 0, 1], ['b', 1, 2], ['c', 2, 3]];
  const seq = compileSequenceEdl([clip('c0', specs)], NO_PAD);
  const single = compileEdl({ mediaId: 'c0', duration: 4, words: clip('c0', specs).words }, NO_PAD);

  assert.deepEqual(seq.keep, single.keep, 'ranges identical to the single-clip compile');
  assert.deepEqual(seq.clips, [{ clipId: 'c0', offset: 0, sourceDuration: 4 }]);
  assert.equal(seq.sourceDuration, 4);
});

test('two clips concatenate on a global timeline, second shifted by the first duration', () => {
  // Clip A: 3s of speech, duration 4. Clip B: 2s, duration 3. B's ranges start at +4.
  const a = clip('A', [['hello', 0, 1], ['there', 1, 2], ['world', 2, 3]]);
  const b = clip('B', [['second', 0, 1], ['clip', 1, 2]]);
  const edl = compileSequenceEdl([a, b], NO_PAD);

  assert.deepEqual(edl.keep, [
    { start: 0, end: 3 }, // A, global == local
    { start: 4, end: 6 }, // B, shifted by A's duration (4)
  ]);
  assert.deepEqual(edl.clips, [
    { clipId: 'A', offset: 0, sourceDuration: 4 },
    { clipId: 'B', offset: 4, sourceDuration: 3 },
  ]);
  assert.equal(edl.sourceDuration, 7, 'total timeline is 4 + 3');
  assert.equal(outputDuration(edl), 5, 'kept 3s from A and 2s from B');
});

test('ranges never merge across a clip seam even when the numbers would touch', () => {
  // A's kept tail ends at its global 3; B's kept head would be at local 0 but
  // globally 4 — and even if B started at local 0 with A ending at duration, the
  // seam is a file boundary, never a splice. Here they are one output-second
  // apart in output terms but MUST stay two ranges: two files.
  const a = clip('A', [['x', 0, 1]]); // duration 2
  const b = clip('B', [['y', 0, 1]]); // duration 2
  const edl = compileSequenceEdl([a, b], { padMs: 0, mergeWithinMs: 1000 });
  assert.equal(edl.keep.length, 2, 'two clips are two ranges, whatever mergeWithin says');
});

test('a deletion inside the second clip cuts only that clip', () => {
  const a = clip('A', [['keep', 0, 1], ['keep', 1, 2]]); // duration 3
  const b = clip('B', [['keep', 0, 1], ['cut', 1, 2, true], ['keep', 2, 3]]); // duration 4
  const edl = compileSequenceEdl([a, b], NO_PAD);
  assert.deepEqual(edl.keep, [
    { start: 0, end: 2 },   // A whole
    { start: 3, end: 4 },   // B first word (global 3-4)
    { start: 5, end: 6 },   // B last word (global 5-6), the deletion at 4-5 is gone
  ]);
});

test('clipAt maps a global time to its clip; localRange strips the offset', () => {
  const a = clip('A', [['x', 0, 1]]); // duration 2, occupies [0,2)
  const b = clip('B', [['y', 0, 1]]); // duration 2, occupies [2,4)
  const edl = compileSequenceEdl([a, b], NO_PAD);

  assert.equal(clipAt(edl, 0.5)?.clipId, 'A');
  assert.equal(clipAt(edl, 2.5)?.clipId, 'B', 'a time past the first clip lands in the second');
  assert.equal(clipAt(edl, 4)?.clipId, 'B', 'the exact tail resolves to the last clip');
  assert.equal(clipAt(edl, -1), null);

  const local = localRange(edl, edl.keep[1]); // B's range, global 2-3
  assert.equal(local?.clip.clipId, 'B');
  assert.deepEqual([local?.start, local?.end], [0, 1], 'offset subtracted back to the file timeline');
});

test('clipAt on a single-source EDL presents one implicit clip', () => {
  const edl = compileEdl({ mediaId: '', duration: 5, words: clip('c0', [['a', 0, 1]]).words }, NO_PAD);
  assert.equal(edl.clips, undefined, 'no clip metadata on a plain single-source EDL');
  assert.equal(clipAt(edl, 0.5)?.clipId, '', 'still resolves, to the implicit clip');
});

test('speed divides the output duration', () => {
  const t = transcript([
    ['hello', 0, 1],
    ['umm', 1, 2, true],
    ['world', 2, 3],
  ]);
  const edl = compileEdl(t, NO_PAD);

  assert.equal(outputDuration(edl), 2, 'the cut alone leaves 2s');
  assert.equal(outputDuration(edl, 1), 2, 'an explicit 1x is the default');
  assert.equal(outputDuration(edl, 2), 1, '2x halves what the cut left');
  assert.equal(outputDuration(edl, 0.5), 4, 'slowing down makes it longer');
  // Speed applies to the EDITED length, not the source: cut then speed, in that
  // order, because that is the order the filtergraph does it in.
  assert.equal(outputDuration(edl, 1.2), 2 / 1.2);
});
