import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileEdl, outputDuration, sourceToOutput, outputToSource } from './edl.ts';
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
