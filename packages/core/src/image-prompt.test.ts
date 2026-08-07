import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GENERATED_ASPECT_RATIOS,
  nearestAspectRatio,
  placeByPrompt,
  promptKeywords,
} from './image-prompt.ts';
import type { Word } from './types.ts';

/**
 * Auto-placement is the one part of the image feature with no interface: the
 * user never confirms it, so a wrong answer here is silent. These pin the rules
 * that make it PREDICTABLE — first mention, prompt order breaks ties, deleted
 * words are invisible — rather than merely correct on one example.
 */

let seq = 0;
const script = (text: string): Word[] =>
  text.split(/\s+/).map((t, i) => ({ id: `w${seq++}`, text: t, start: i, end: i + 0.4 }));

// ── keywords ──────────────────────────────────────────────────────────────────

test('stopwords and the vocabulary of asking for a picture are dropped', () => {
  // "picture of a" is what people type and never what they say about the
  // subject; matching it would land the image on the word "picture".
  assert.deepEqual(promptKeywords('a picture of a robot'), ['robot']);
  assert.deepEqual(promptKeywords('an image showing the ocean'), ['ocean']);
  assert.deepEqual(promptKeywords('wide angle shot of a mountain'), ['mountain']);
});

test('keywords keep prompt order and lose duplicates', () => {
  assert.deepEqual(promptKeywords('a robot and another robot in a field'), ['robot', 'another', 'field']);
});

test('plurals fold onto singulars, in one shallow step', () => {
  assert.deepEqual(promptKeywords('robots'), ['robot']);
  assert.deepEqual(promptKeywords('berries'), ['berry']);
  assert.deepEqual(promptKeywords('boxes'), ['box']);
  // Not over-stemmed: a real stemmer would fold these somewhere surprising.
  assert.deepEqual(promptKeywords('business'), ['business']);
  assert.deepEqual(promptKeywords('glass'), ['glass']);
});

test('a prompt with no content words yields nothing rather than something', () => {
  assert.deepEqual(promptKeywords('a picture of the'), []);
  assert.deepEqual(promptKeywords(''), []);
  assert.deepEqual(promptKeywords('   '), []);
});

// ── placement ─────────────────────────────────────────────────────────────────

test('an image lands on the first time the subject is said', () => {
  const words = script('so I built a robot and the robot could walk');
  const at = placeByPrompt(words, 'a friendly robot waving')!;
  assert.equal(at.matched, 'robot');
  assert.equal(at.wordText, 'robot');
  // The FIRST mention — where the idea is introduced.
  assert.equal(at.start, words.findIndex((w) => w.text === 'robot'));
});

test('prompt order breaks ties, not transcript order', () => {
  // The speaker says "field" long before "robot", but the prompt's subject is
  // the robot — placing it on "field" is the confidently-wrong answer.
  const words = script('I walked through a field for hours before I saw the robot');
  const at = placeByPrompt(words, 'a robot in a field')!;
  assert.equal(at.matched, 'robot');
});

test('plural in the script matches a singular prompt and vice versa', () => {
  assert.equal(placeByPrompt(script('we had many robots there'), 'one robot')!.wordText, 'robots');
  assert.equal(placeByPrompt(script('the robot was fine'), 'some robots')!.wordText, 'robot');
});

test('punctuation and case do not stop a match', () => {
  assert.equal(placeByPrompt(script('and then — Robots! everywhere'), 'a robot')!.matched, 'robot');
});

test('deleted words are invisible, because they are not in the output', () => {
  const words = script('the robot walked and the robot ran');
  const hits = words.filter((w) => w.text === 'robot');
  words[hits[0] === words[1] ? 1 : words.indexOf(hits[0])].deleted = true;
  const at = placeByPrompt(words, 'a robot')!;
  assert.equal(at.wordId, hits[1].id, 'placed on the surviving mention');
});

test('nothing matching means nothing placed — not a guess', () => {
  // The honest answer. A thematic guess here would be unpredictable and the
  // user never gets to confirm it.
  assert.equal(placeByPrompt(script('we talked about the weather'), 'a robot'), null);
  assert.equal(placeByPrompt(script('anything at all'), 'a picture of the'), null);
  assert.equal(placeByPrompt([], 'a robot'), null);
});

test('an all-deleted transcript places nothing', () => {
  const words = script('the robot walked');
  for (const w of words) w.deleted = true;
  assert.equal(placeByPrompt(words, 'a robot'), null);
});

// ── the generated shape ───────────────────────────────────────────────────────

test('the frame the video ships in picks the ratio', () => {
  assert.equal(nearestAspectRatio(1920, 1080), '16:9');
  assert.equal(nearestAspectRatio(1080, 1920), '9:16');
  assert.equal(nearestAspectRatio(1080, 1080), '1:1');
  assert.equal(nearestAspectRatio(1440, 1080), '4:3');
  assert.equal(nearestAspectRatio(2560, 1080), '21:9');
});

test('an odd frame snaps to the nearest ratio the model will honour', () => {
  // Out-of-list ratios are silently rewritten to 1:1 by the API rather than
  // rejected, so the snap has to happen on our side.
  assert.ok(GENERATED_ASPECT_RATIOS.includes(nearestAspectRatio(1234, 987)));
  assert.equal(nearestAspectRatio(1918, 1080), '16:9', 'a couple of pixels off is still 16:9');
});

test('the ratio is chosen in log space, so portrait is not pulled towards square', () => {
  // 9:16 (0.5625) is linearly closer to 1:1 than 21:9 (2.33) is to 16:9 (1.78),
  // so a linear comparison would treat a portrait frame as nearly square.
  assert.equal(nearestAspectRatio(900, 1600), '9:16');
  // The mirror of a 16:9 frame must be the mirror ratio, not something rounder.
  assert.equal(nearestAspectRatio(1080, 1440), '3:4');
});

test('an unprobed frame falls back to 16:9 rather than to a square', () => {
  assert.equal(nearestAspectRatio(0, 0), '16:9');
  assert.equal(nearestAspectRatio(1920, 0), '16:9');
  assert.equal(nearestAspectRatio(NaN, NaN), '16:9');
});
