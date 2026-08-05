import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectFillers, removeFillers } from './fillers.ts';
import { detectRetakes, removeRetakes } from './retakes.ts';
import { compileEdl, outputDuration } from './edl.ts';
import { uniqueWordIds } from './transcript.ts';
import { buildWordPatch } from './doc.ts';
import type { Transcript, Word } from './types.ts';

/** Build a transcript from a sentence, one word per 0.5s. */
function fromText(text: string): Transcript {
  const words = text.split(/\s+/).map((t, i) => ({
    id: `w${i}`,
    text: t,
    start: i * 0.5,
    end: i * 0.5 + 0.5,
  }));
  return { mediaId: 'test', duration: words.length * 0.5, words };
}

const kept = (t: Transcript) => t.words.filter((w) => !w.deleted).map((w) => w.text).join(' ');

test('detectFillers tags hesitations and leaves real words alone', () => {
  const t = fromText('well um I think uh this works');
  const found = detectFillers(t);
  assert.equal(found, 2);
  assert.deepEqual(
    t.words.filter((w) => w.isFiller).map((w) => w.text),
    ['um', 'uh'],
  );
});

test('a "so" that opens the utterance is a filler', () => {
  const t = fromText('So we shipped it.');
  detectFillers(t);
  assert.deepEqual(t.words.filter((w) => w.isFiller).map((w) => w.text), ['So']);
});

test('a "so" mid-sentence is a real word and survives', () => {
  // Every one of these breaks if the word is cut: degree modifier, then
  // complementizer, then the "and so on" idiom.
  const t = fromText('it was so big so that we so on and so forth kept it');
  assert.equal(detectFillers(t), 0);
});

test('a leading "so" starting a new sentence is a filler, but a degree "so" is not', () => {
  const t = fromText('That worked. So we moved on. So many people asked.');
  detectFillers(t);
  assert.deepEqual(
    t.words.filter((w) => w.isFiller).map((w) => w.text),
    ['So'],
    'the second "So" is "so many" — load-bearing',
  );
});

test('a "so" after a long pause opens an utterance even without punctuation', () => {
  const t = fromText('right so we tried it');
  // No sentence-ending mark, so only the beat before it can mark the restart.
  t.words[1].start = t.words[0].end + 0.8;
  t.words[1].end = t.words[1].start + 0.5;
  detectFillers(t);
  assert.deepEqual(t.words.filter((w) => w.isFiller).map((w) => w.text), ['so']);
});

test('detectFillers does not treat "like" as a filler', () => {
  const t = fromText('I like cities like Paris');
  assert.equal(detectFillers(t), 0, 'removing these would change the meaning');
});

test('detectFillers catches hesitations held for any length', () => {
  // A verbatim model spells the sound as long as it was held. A fixed list
  // stops somewhere; these all have to match regardless of how many letters.
  const t = fromText('um umm ummmm uh uhh uhhhhh uhm erm hmmm mmm ahh eh');
  assert.equal(detectFillers(t), t.words.length, 'every one is a hesitation');
});

test('detectFillers survives punctuation and casing from real ASR output', () => {
  const t = fromText('Um, I think... Uh! yes Mm.');
  detectFillers(t);
  assert.deepEqual(
    t.words.filter((w) => w.isFiller).map((w) => w.text),
    ['Um,', 'Uh!', 'Mm.'],
  );
});

test('detectFillers leaves real words that look like hesitations alone', () => {
  // "uh-huh" and "mm-hmm" mean yes; "hum"/"harm"/"ohm" are ordinary words.
  // Losing any of these to an over-eager pattern would corrupt the edit.
  const t = fromText('uh-huh I hum a tune to harm no one at one ohm aha amen');
  assert.equal(detectFillers(t), 0);
});

test('discourse markers are opt-in, not default', () => {
  const t = fromText('it was you know pretty good');
  assert.equal(detectFillers(t), 0);
  assert.equal(detectFillers(t, { includeDiscourseMarkers: true }), 2);
});

test('removeFillers deletes tagged words and the EDL drops their audio', () => {
  const t = fromText('hello um world');
  detectFillers(t);
  assert.equal(removeFillers(t), 1);
  assert.equal(kept(t), 'hello world');

  const edl = compileEdl(t, { padMs: 0, mergeWithinMs: 0 });
  assert.deepEqual(edl.keep, [
    { start: 0, end: 0.5 },
    { start: 1.0, end: 1.5 },
  ]);
  assert.equal(outputDuration(edl), 1.0, 'the half-second "um" is gone');
});

test('detectRetakes finds an immediate false start and keeps the last take', () => {
  const t = fromText('I want to I want to talk about this');
  const retakes = detectRetakes(t);
  assert.equal(retakes.length, 1);
  assert.equal(retakes[0].text, 'I want to');
  assert.equal(retakes[0].start, 0);

  removeRetakes(t);
  assert.equal(kept(t), 'I want to talk about this');
});

test('detectRetakes handles an interruption between the takes', () => {
  const t = fromText('the point is uh the point is nobody knows');
  removeRetakes(t);
  assert.equal(kept(t), 'the point is nobody knows', 'the stranded "uh" is cut too');
});

test('detectRetakes prefers the longest repeated run', () => {
  const t = fromText('we should build we should build a demo');
  const retakes = detectRetakes(t);
  assert.equal(retakes.length, 1);
  assert.equal(retakes[0].text, 'we should build');
});

test('ordinary repetition below minWords is not a retake', () => {
  const t = fromText('that is very very good');
  assert.deepEqual(detectRetakes(t), [], 'a single repeated word is emphasis, not a false start');
});

test('unrelated repeated phrases far apart are not treated as retakes', () => {
  const t = fromText('the cat sat down and then later on the cat sat again');
  assert.deepEqual(detectRetakes(t), [], 'too far apart to be a false start');
});

test('fillers and retakes compose into one EDL', () => {
  const t = fromText('um I think I think we should ship uh today');
  detectFillers(t);
  removeFillers(t);
  removeRetakes(t);
  assert.equal(kept(t), 'I think we should ship today');

  const edl = compileEdl(t, { padMs: 0, mergeWithinMs: 0 });
  assert.equal(outputDuration(edl), 3.0, '6 kept words x 0.5s');
});

// ── word id uniqueness across clips ───────────────────────────────────────────

/** One clip's ASR output: ids restart at w0 for every file, as the real one does. */
function clipWords(clipId: string, text: string): Word[] {
  return text.split(/\s+/).map((t, i) => ({
    id: `w${i * 2}`,
    text: t,
    start: i * 0.5,
    end: i * 0.5 + 0.5,
    clipId,
  }));
}

test('uniqueWordIds leaves a single-clip script exactly as it was', () => {
  const words = fromText('nothing here repeats').words;
  assert.equal(uniqueWordIds(words), words, 'same array, so nothing downstream sees a change');
});

test('uniqueWordIds separates the twins two stitched clips produce', () => {
  const stitched = [...clipWords('A', 'hello wrold there'), ...clipWords('B', 'second clip wrold')];
  assert.equal(new Set(stitched.map((w) => w.id)).size, 3, 'the bug: 6 words, 3 ids');

  const fixed = uniqueWordIds(stitched);
  assert.equal(fixed.length, 6);
  assert.equal(new Set(fixed.map((w) => w.id)).size, 6);
  assert.deepEqual(
    fixed.map((w) => w.text),
    ['hello', 'wrold', 'there', 'second', 'clip', 'wrold'],
    'text and order are untouched — only ids move',
  );
  // The first clip keeps its ids, so an existing project's words are unchanged.
  assert.deepEqual(fixed.slice(0, 3).map((w) => w.id), ['w0', 'w2', 'w4']);
  assert.deepEqual(fixed.slice(3).map((w) => w.id), ['B:w0', 'B:w2', 'B:w4']);
});

test('uniqueWordIds is idempotent', () => {
  const once = uniqueWordIds([...clipWords('A', 'a b'), ...clipWords('B', 'c d')]);
  assert.equal(uniqueWordIds(once), once, 'a repaired script is already clean');
});

test('correcting a word after uniqueWordIds touches only that word', () => {
  const fixed = uniqueWordIds([...clipWords('A', 'hello wrold'), ...clipWords('B', 'bye wrold')]);
  const patch = buildWordPatch(fixed, ['w2'], { text: 'world' });
  assert.equal(patch.kind, 'words');
  assert.equal(patch.kind === 'words' && patch.edits.length, 1, 'clip B is not dragged along');
  const after = fixed.map((w) => (w.id === 'w2' ? { ...w, text: 'world' } : w));
  assert.deepEqual(after.map((w) => w.text), ['hello', 'world', 'bye', 'wrold']);
});

test('uniqueWordIds survives a hand-edited record with no clipId', () => {
  const words: Word[] = [
    { id: 'w0', text: 'a', start: 0, end: 1 },
    { id: 'w0', text: 'b', start: 1, end: 2 },
    { id: 'w0', text: 'c', start: 2, end: 3 },
  ];
  const fixed = uniqueWordIds(words);
  assert.equal(new Set(fixed.map((w) => w.id)).size, 3);
});
