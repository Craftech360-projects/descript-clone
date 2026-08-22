import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deepgramWords } from './asr.ts';

/**
 * Deepgram's response shape, which nothing else in this repo would catch.
 *
 * The words sit four levels down — results.channels[0].alternatives[0].words —
 * and every provider nests differently. A wrong path does not throw; it yields an
 * empty array, and the failure surfaces much later as "no usable word-level
 * timings" with nothing pointing at the parser.
 */

const payload = (words: unknown[]) => ({
  results: { channels: [{ alternatives: [{ words }] }] },
});

test('the words come out of the nest, in order, with timings', () => {
  const out = deepgramWords(
    payload([
      { word: 'so', punctuated_word: 'So', start: 0.1, end: 0.4, confidence: 0.99 },
      { word: 'um', punctuated_word: 'um,', start: 0.5, end: 0.8, confidence: 0.9 },
      { word: 'today', punctuated_word: 'today', start: 0.9, end: 1.3, confidence: 0.98 },
    ]),
  );
  assert.equal(out.length, 3);
  assert.deepEqual(out.map((w) => w.text), ['So', 'um,', 'today']);
  assert.deepEqual(out.map((w) => w.id), ['w0', 'w1', 'w2']);
  assert.equal(out[1].start, 0.5);
  assert.equal(out[1].end, 0.8);
});

test('the punctuated form wins — a human reads this while editing', () => {
  const [w] = deepgramWords(payload([{ word: 'hello', punctuated_word: 'Hello,', start: 0, end: 1 }]));
  assert.equal(w.text, 'Hello,');
});

test('a filler survives, which is the whole reason filler_words is set', () => {
  // Deepgram strips um/uh unless filler_words=true. fillers.ts normalizes
  // punctuation away before matching, so "um," still reads as a filler — the same
  // property that makes Apple's "um," work.
  const [w] = deepgramWords(payload([{ word: 'um', punctuated_word: 'um,', start: 1, end: 1.2 }]));
  assert.equal(w.text, 'um,');
});

test('speakers are numbered from 0 and become labels', () => {
  const out = deepgramWords(
    payload([
      { word: 'a', start: 0, end: 1, speaker: 0 },
      { word: 'b', start: 1, end: 2, speaker: 1 },
    ]),
  );
  assert.equal(out[0].speaker, 'Speaker 1', 'not "Speaker 0" — people count from one');
  assert.equal(out[1].speaker, 'Speaker 2');
});

test('no diarization means no speaker, not a fake one', () => {
  const [w] = deepgramWords(payload([{ word: 'a', start: 0, end: 1 }]));
  assert.equal(w.speaker, undefined);
});

test('zero-length and reversed words are dropped', () => {
  // They would land in the document as unselectable slivers, and a zero-length
  // range breaks the EDL maths downstream.
  const out = deepgramWords(
    payload([
      { word: 'ok', start: 1, end: 1 },
      { word: 'bad', start: 2, end: 1.5 },
      { word: 'good', start: 3, end: 3.5 },
    ]),
  );
  assert.deepEqual(out.map((w) => w.text), ['good']);
});

test('an empty or blank word is dropped rather than becoming a blank token', () => {
  const out = deepgramWords(payload([{ word: '   ', start: 0, end: 1 }, { word: 'x', start: 1, end: 2 }]));
  assert.deepEqual(out.map((w) => w.text), ['x']);
});

test('a missing timing is dropped rather than becoming NaN', () => {
  const out = deepgramWords(payload([{ word: 'a', start: 0 }, { word: 'b', start: 1, end: 2 }]));
  assert.deepEqual(out.map((w) => w.text), ['b']);
});

test('a shape we do not recognise yields nothing, and does not throw', () => {
  // The caller turns an empty result into an error naming this function, which is
  // more useful than a TypeError from four levels of optional chaining.
  assert.deepEqual(deepgramWords({}), []);
  assert.deepEqual(deepgramWords(null), []);
  assert.deepEqual(deepgramWords({ results: { channels: [] } }), []);
  assert.deepEqual(deepgramWords({ words: [{ word: 'wrong-nesting', start: 0, end: 1 }] }), []);
});
