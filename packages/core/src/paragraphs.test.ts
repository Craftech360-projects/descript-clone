import { test } from 'node:test';
import assert from 'node:assert/strict';

import { lastStartingAtOrBefore, wordAt } from './paragraphs.ts';
import type { Word } from './types.ts';

/** The linear scan wordAt used to be. The bisect must agree with it exactly. */
function wordAtLinear(words: Word[], sourceTime: number): number {
  for (let i = 0; i < words.length; i++) {
    if (sourceTime >= words[i].start && sourceTime < words[i].end) return i;
    if (words[i].start > sourceTime) break;
  }
  return -1;
}

function build(spans: Array<[number, number]>): Word[] {
  return spans.map(([start, end], i) => ({ id: `w${i * 2}`, text: `w${i}`, start, end }));
}

test('wordAt matches the linear scan it replaced, exhaustively', () => {
  // Contiguous words, gaps between words, and a long pause — the three shapes
  // that actually occur in ASR output.
  const words = build([
    [0, 1], [1, 2], [2, 2.5],   // contiguous
    [4, 5],                      // after a gap
    [5, 6], [6, 7],              // contiguous again
    [12, 13],                    // after a long pause
  ]);

  for (let t = -1; t <= 15; t += 0.05) {
    const time = Math.round(t * 1000) / 1000;
    assert.equal(wordAt(words, time), wordAtLinear(words, time), `disagreement at t=${time}`);
  }
});

test('wordAt returns -1 inside a pause and before the first word', () => {
  const words = build([[0, 1], [4, 5]]);
  assert.equal(wordAt(words, 2), -1, 'inside a pause');
  assert.equal(wordAt(words, -1), -1, 'before the start');
  assert.equal(wordAt(words, 99), -1, 'past the end');
});

test('wordAt is half-open: [start, end)', () => {
  const words = build([[1, 2], [2, 3]]);
  assert.equal(wordAt(words, 1), 0, 'start is inclusive');
  assert.equal(wordAt(words, 2), 1, 'end is exclusive — 2 belongs to the next word');
});

test('wordAt handles the boundaries of the list', () => {
  const words = build([[0, 1], [1, 2], [2, 3]]);
  assert.equal(wordAt(words, 0), 0);
  assert.equal(wordAt(words, 2.999), 2);
  assert.equal(wordAt([], 5), -1, 'empty transcript must not throw');
});

test('lastStartingAtOrBefore lands on the word you just heard, inside a pause', () => {
  const words = build([[0, 1], [4, 5]]);
  assert.equal(lastStartingAtOrBefore(words, 2), 0, 'a pause belongs to the preceding word');
  assert.equal(lastStartingAtOrBefore(words, -1), -1, 'nothing precedes the first word');
  assert.equal(lastStartingAtOrBefore(words, 99), 1);
});
