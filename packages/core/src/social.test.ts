import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPrompt,
  condenseTranscript,
  normalizeHashtags,
  parseDraft,
  targetFor,
} from './social.ts';

const reels = targetFor('reels');

test('an unknown target falls back rather than throwing', () => {
  assert.equal(targetFor('myspace').id, 'generic');
});

test('plain JSON is read', () => {
  const d = parseDraft('{"title":"A","description":"B","hashtags":["#c"]}', reels);
  assert.deepEqual(d, { title: 'A', description: 'B', hashtags: ['#c'] });
});

/**
 * Small models wrap their answer in prose and code fences constantly. Refusing
 * those would throw away good copy over punctuation.
 */
test('a fenced answer buried in prose is still read', () => {
  const raw = 'Sure! Here you go:\n```json\n{"title":"A","description":"B","hashtags":["#c"]}\n```\nHope that helps.';
  assert.equal(parseDraft(raw, reels)?.title, 'A');
});

test('hashtags sent as a string are accepted', () => {
  const d = parseDraft('{"title":"A","description":"B","hashtags":"cheeko, toddler firsttaste"}', reels);
  assert.deepEqual(d?.hashtags, ['#cheeko', '#toddler', '#firsttaste']);
});

test('an answer with no JSON at all is null, not an empty draft', () => {
  assert.equal(parseDraft('I cannot help with that.', reels), null);
  assert.equal(parseDraft('', reels), null);
});

test('a draft with neither title nor description is null', () => {
  assert.equal(parseDraft('{"hashtags":["#a"]}', reels), null);
});

test('copy is clipped to the platform, not left to overflow', () => {
  const long = 'x'.repeat(500);
  const d = parseDraft(JSON.stringify({ title: long, description: long, hashtags: [] }), reels);
  assert.equal(d!.title.length, reels.titleMax);
  assert.equal(d!.description.length, Math.min(500, reels.descriptionMax));
});

test('hashtags are deduped, cleaned and capped', () => {
  const tags = normalizeHashtags(['#One', 'one', '##two!', 'thr ee', '#four', '#five', '#six', '#seven', '#eight', '#nine', '#ten', '#eleven'], 8);
  assert.equal(tags[0], '#one');
  assert.ok(!tags.includes('#One'), 'case-different duplicates collapse');
  assert.equal(tags[1], '#two', 'punctuation is stripped');
  assert.ok(tags.length <= 8);
  assert.ok(tags.every((t) => t.startsWith('#') && !t.includes(' ')));
});

test('hashtags survive non-latin scripts', () => {
  assert.deepEqual(normalizeHashtags(['#यात्रा', '#中国'], 5), ['#यात्रा', '#中国']);
});

test('a short transcript is sent whole', () => {
  const t = 'a b c';
  assert.equal(condenseTranscript(t, 4000), 'a b c');
});

test('a long transcript keeps its opening and its ending', () => {
  const text = `START${'m'.repeat(20000)}END`;
  const out = condenseTranscript(text, 1000);
  assert.ok(out.length < text.length);
  assert.ok(out.startsWith('START'), 'the opening decides the title');
  assert.ok(out.endsWith('END'), 'the ending decides how it lands');
  assert.ok(out.includes('…'), 'and it must be honest that there is a gap');
});

/**
 * The brief is the whole reason this feature is better than asking a model to
 * summarise. If it stops reaching the prompt, the copy silently becomes generic.
 */
test('the folder brief reaches the prompt, and is asked to be used', () => {
  const p = buildPrompt({
    transcript: 'we went to the market',
    brief: 'Cheeko is my two-year-old. Titles always name him.',
    target: reels,
    projectName: 'clip.mp4',
  });
  assert.ok(p.includes('Cheeko is my two-year-old'));
  assert.ok(/use it/i.test(p), 'the model must be told the brief matters');
  assert.ok(p.includes('80'), 'the platform limit is stated');
});

test('with no brief the prompt says so rather than inventing a personality', () => {
  const p = buildPrompt({ transcript: 'hello', brief: '   ', target: reels, projectName: 'a.mp4' });
  assert.ok(/Nothing recorded yet/i.test(p));
});

/**
 * Hashtags on a runtime with no ICU.
 *
 * The Android build ships nodejs-mobile, which has no ICU data, and there a
 * `\p{...}` regex does not mis-match — it fails to COMPILE. Because a regex
 * literal compiles when the module is PARSED, that took down the whole server
 * bundle at import and the app died on its splash screen. These pin both the
 * behaviour we want where ICU exists and the fallback's one non-negotiable
 * property: it must never delete a script.
 */
test('hashtags keep combining marks, so Devanagari survives', () => {
  // The case the property escape existed for: strip the matras and "यात्रा"
  // becomes "यतर", which is not a word in any language.
  const [tag] = normalizeHashtags(['#यात्रा'], 5);
  assert.equal(tag, '#यात्रा');
});

test('hashtags strip punctuation and keep letters, digits, underscore', () => {
  assert.deepEqual(normalizeHashtags(['#hello!world', '#a_1', '#with space'], 5), [
    '#helloworld',
    '#a_1',
    '#withspace',
  ]);
});

test('the ICU-free fallback keeps non-Latin scripts intact', () => {
  // Exercising the fallback directly, since the test runtime HAS ICU: whatever
  // the fallback does, it must not empty out a non-Latin string. A hashtag that
  // is slightly too permissive is recoverable; one that deleted a language is not.
  const fallback = /[^0-9A-Za-z_À-ɏͰ-￿]/g;
  for (const s of ['यात्रा', '日本語', 'Ελλάδα', 'Россия', 'العربية']) {
    assert.equal(s.replace(fallback, ''), s, `${s} must survive the no-ICU fallback`);
  }
  // and it still removes what a hashtag cannot contain
  assert.equal('a!b c'.replace(fallback, ''), 'abc');
});
