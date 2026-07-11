import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCues, toSrt } from './captions.ts';
import { compileEdl } from './edl.ts';
import type { Transcript } from './types.ts';

function fromText(text: string, deletedIdx: number[] = []): Transcript {
  const words = text.split(/\s+/).map((t, i) => ({
    id: `w${i}`,
    text: t,
    start: i,
    end: i + 1,
    deleted: deletedIdx.includes(i),
  }));
  return { mediaId: 'test', duration: words.length, words };
}

const NO_PAD = { padMs: 0, mergeWithinMs: 0 };

test('cues are timed against the OUTPUT timeline, not the source', () => {
  // "one two three four" with "two" and "three" cut. In the source, "four"
  // starts at 3s. In the 2s output, it must start at 1s.
  const t = fromText('one two three four', [1, 2]);
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 3 }); // force one word per cue

  assert.equal(cues.length, 2);
  assert.equal(cues[0].text, 'one');
  assert.equal(cues[0].start, 0);

  assert.equal(cues[1].text, 'four');
  assert.equal(
    cues[1].start,
    1,
    'four starts at 3s in the source but 1s in the cut — captioning off source time would drift by exactly the amount cut',
  );
});

test('deleted words never appear in captions', () => {
  const t = fromText('keep cut keep', [1]);
  const edl = compileEdl(t, NO_PAD);
  const text = toCues(t, edl).map((c) => c.text).join(' ');
  assert.equal(text.includes('cut'), false);
});

test('cues wrap at the character limit', () => {
  const t = fromText('alpha bravo charlie delta echo foxtrot');
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 14 });
  assert.ok(cues.length > 1);
  for (const cue of cues) {
    assert.ok(cue.text.length <= 14, `"${cue.text}" is ${cue.text.length} chars, over the limit`);
  }
});

test('a cue never spans a cut', () => {
  const t = fromText('a b c d e f', [2, 3]);
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 100, maxDurationMs: 100000 });

  // Even with limits that would happily merge everything, the splice forces a break.
  assert.ok(cues.length >= 1);
  for (const cue of cues) {
    assert.equal(cue.text.includes('c'), false);
    assert.equal(cue.text.includes('d'), false);
  }
});

test('cues respect the max duration', () => {
  const t = fromText('a b c d e f g h');
  const edl = compileEdl(t, NO_PAD);
  const cues = toCues(t, edl, { maxChars: 999, maxDurationMs: 3000 });
  for (const cue of cues) {
    assert.ok(cue.end - cue.start <= 3.5, `cue held ${(cue.end - cue.start).toFixed(1)}s`);
  }
});

test('SRT output is well formed', () => {
  const t = fromText('hello world');
  const edl = compileEdl(t, NO_PAD);
  const srt = toSrt(toCues(t, edl));

  assert.match(srt, /^1\n00:00:00,000 --> 00:00:0[12],\d{3}\nhello world\n/);
});

test('no cues when everything is deleted, rather than a crash', () => {
  const t = fromText('a b', [0, 1]);
  const edl = compileEdl(t, NO_PAD);
  assert.deepEqual(toCues(t, edl), []);
});
