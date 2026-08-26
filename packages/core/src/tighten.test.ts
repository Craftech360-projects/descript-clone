import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compileEdl, outputDuration } from './edl.ts';
import {
  planTighten,
  previewTighten,
  reportTighten,
  REEL_PAUSE_MS,
  type TightenOptions,
} from './tighten.ts';
import { DEFAULT_COMPILE_OPTIONS, type CompileOptions, type Word } from './types.ts';

const CUT: CompileOptions = { padMs: 40, fadeMs: 12, mergeWithinMs: 20, maxGapMs: Infinity };

/**
 * Build words from "text@start-end" specs, so a test reads as a spoken line
 * with its silences visible rather than as a wall of object literals.
 */
function speak(spec: string): Word[] {
  return spec
    .trim()
    .split(/\s+/)
    .map((token, i) => {
      const [text, span] = token.split('@');
      const [start, end] = span.split('-').map(Number);
      return { id: `w${i}`, text, start, end };
    });
}

const opts = (over: Partial<TightenOptions> = {}): TightenOptions => ({
  fillers: { includeDiscourseMarkers: false },
  retakes: { minWords: 2 },
  maxGapMs: REEL_PAUSE_MS,
  cut: CUT,
  ...over,
});

test('one plan covers all three sweeps', () => {
  //                 um is a filler; "I want to" is said twice; then a 2s pause.
  const words = speak(`
    um@0-0.2 I@0.3-0.4 want@0.4-0.6 to@0.6-0.7
    I@0.8-0.9 want@0.9-1.1 to@1.1-1.2 talk@1.2-1.6
    uh@1.7-1.9 about@1.9-2.3 this@4.5-5.0
  `);

  const plan = planTighten(words, opts());

  assert.deepEqual(plan.fillerIds, ['w0', 'w8']); // um, uh
  assert.equal(plan.retakes, 1);
  assert.deepEqual(plan.retakeIds, ['w1', 'w2', 'w3']); // the abandoned "I want to"
  assert.equal(plan.pauses, 1); // the 2.2s hole before "this"
  assert.equal(plan.empty, false);
  assert.deepEqual(plan.cutIds, ['w0', 'w1', 'w2', 'w3', 'w8']);
});

test('the plan never mutates the words it is given', () => {
  const words = speak('um@0-0.2 hello@0.3-0.7');
  planTighten(words, opts());
  // detectFillers tags IN PLACE. If the clone were skipped, isFiller would be
  // written onto the live document with no patch behind it.
  assert.equal(words[0].isFiller, undefined);
  assert.equal(words[0].deleted, undefined);
});

test('a word claimed by the filler sweep is not counted again as a retake', () => {
  // "so" opens the utterance (a filler) AND opens the abandoned take.
  const words = speak(`
    so@0-0.2 I@0.3-0.5 said@0.5-0.8
    so@0.9-1.1 I@1.2-1.4 said@1.4-1.7 yes@1.8-2.1
  `);
  const plan = planTighten(words, opts());

  const overlap = plan.retakeIds.filter((id) => plan.fillerIds.includes(id));
  assert.deepEqual(overlap, []);
  // Union, each id once.
  assert.equal(new Set(plan.cutIds).size, plan.cutIds.length);
  assert.equal(plan.cutIds.length, plan.fillerIds.length + plan.retakeIds.length);
});

test('a false start whose words are already gone is not reported again', () => {
  const words = speak(`
    I@0-0.2 said@0.2-0.5 I@0.6-0.8 said@0.8-1.1 yes@1.2-1.5
  `);
  const first = planTighten(words, opts());
  assert.equal(first.retakes, 1);

  // Apply it: mark the plan's ids deleted, exactly as the store's patch does.
  const after = words.map((w) => (first.cutIds.includes(w.id) ? { ...w, deleted: true } : w));

  // detectRetakes matches TEXT and knows nothing about edit state, so it still
  // finds the same range. The plan must not claim it a second time.
  const second = planTighten(after, opts({ cut: { ...CUT, maxGapMs: REEL_PAUSE_MS } }));
  assert.equal(second.retakes, 0);
  assert.deepEqual(second.cutIds, []);
  assert.equal(second.empty, true);
});

test('pauses are counted after this plan\'s own cuts, not before them', () => {
  // A 1.5s hole sits either side of a filler. Cutting the filler makes both
  // holes DELETION cuts, which the compiler makes unconditionally — so no pause
  // is left for maxGapMs to shorten, and the plan must not claim one.
  const words = speak('hello@0-0.4 um@1.9-2.1 there@3.6-4.0');

  const withSweep = planTighten(words, opts());
  assert.equal(withSweep.fillerIds.length, 1);
  assert.equal(withSweep.pauses, 0);

  // Leave the filler in and the same two gaps ARE ordinary pauses.
  const noSweep = planTighten(words, opts({ fillers: null }));
  assert.equal(noSweep.pauses, 2);
});

test('a pause too small to be worth a cut is not counted', () => {
  // 480ms is the floor at this pad and min-trim: gap - cap - 2*pad >= minTrim
  // is 0.48 - 0.15 - 0.08 = 0.25. A hair under and the compiler declines.
  // (490ms rather than exactly 480 because binary floating point puts the exact
  // boundary at 0.24999999999999997 — the compiler makes the same call, so this
  // is a fact about the arithmetic both sides share, not slack in the test.)
  const worth = planTighten(speak('a@0-0.1 b@0.59-0.7'), opts());
  assert.equal(worth.pauses, 1);

  const notWorth = planTighten(speak('a@0-0.1 b@0.57-0.7'), opts());
  assert.equal(notWorth.pauses, 0);
  // The cap still moves — the plan is not empty, it just shortens nothing.
  assert.equal(notWorth.capChanged, true);
  assert.equal(notWorth.empty, false);
});

test('the seconds promised are the seconds the compiler actually removes', () => {
  const words = speak('a@0-0.5 b@3.0-3.5 c@6.5-7.0');
  const plan = planTighten(words, opts({ fillers: null, retakes: null }));

  const transcript = { mediaId: 'm', duration: 8, words };
  const before = outputDuration(compileEdl(transcript, CUT));
  const after = outputDuration(
    compileEdl(transcript, { ...CUT, maxGapMs: plan.maxGapMs ?? Infinity }),
  );

  assert.equal(plan.pauses, 2);
  // Within a frame at 60fps — this is the number the preview puts on screen.
  assert.ok(Math.abs(before - after - plan.pausesSec) < 1 / 60, `${before - after} vs ${plan.pausesSec}`);
});

test('a gap across a clip seam is two files, not a pause', () => {
  const words = speak('a@0-0.5 b@3.0-3.5');
  words[0].clipId = 'clip-1';
  words[1].clipId = 'clip-2';
  const plan = planTighten(words, opts({ fillers: null, retakes: null }));
  assert.equal(plan.pauses, 0);
});

test('tighten never loosens a cap the user already set tighter', () => {
  const plan = planTighten(speak('a@0-0.5 b@3.0-3.5'), opts({ cut: { ...CUT, maxGapMs: 80 } }));
  assert.equal(plan.maxGapMs, 80);
  assert.equal(plan.capChanged, false);
  // 80ms was already in force, so nothing here is newly shortened.
  assert.equal(plan.pauses, 0);
});

test('the pause count is a delta, so running twice reports the work once', () => {
  const words = speak('a@0-0.5 b@3.0-3.5 c@6.5-7.0');
  const first = planTighten(words, opts({ fillers: null, retakes: null }));
  assert.equal(first.pauses, 2);

  const second = planTighten(
    words,
    opts({ fillers: null, retakes: null, cut: { ...CUT, maxGapMs: first.maxGapMs ?? Infinity } }),
  );
  assert.equal(second.pauses, 0);
  assert.equal(second.empty, true);
});

test('an absent minTrimMs falls back to the compiler default, not to NaN', () => {
  // Every real doc.cut arrives without it — see EDIT_DEFAULTS on the server.
  const words = speak('a@0-0.5 b@3.0-3.5');
  const bare = planTighten(words, opts({ fillers: null, retakes: null }));
  const explicit = planTighten(
    words,
    opts({
      fillers: null,
      retakes: null,
      cut: { ...CUT, minTrimMs: DEFAULT_COMPILE_OPTIONS.minTrimMs },
    }),
  );
  assert.equal(bare.pauses, 1);
  assert.deepEqual(bare.pauses, explicit.pauses);
});

test('a step that would do nothing is absent from the preview', () => {
  const plan = planTighten(speak('hello@0-0.4 there@0.5-0.9'), opts());
  assert.deepEqual(previewTighten(plan), [
    // No fillers, no false starts, no pause long enough — only the cap moves.
    `Cap pauses at ${REEL_PAUSE_MS}ms — none in this script are long enough to shorten`,
  ]);
});

test('the preview lists each sweep in the order it is applied', () => {
  const words = speak(`
    um@0-0.2 I@0.3-0.4 want@0.4-0.6
    I@0.8-0.9 want@0.9-1.1 to@1.1-1.6 this@4.5-5.0
  `);
  const lines = previewTighten(planTighten(words, opts()));
  assert.deepEqual(lines, [
    'Cut 1 filler word',
    'Cut 1 false start — 2 more words',
    'Shorten 1 pause to 150ms — 2.7s of silence',
  ]);
});

test('the report says what happened, and says so plainly when nothing did', () => {
  const words = speak('um@0-0.2 hello@0.3-0.7 there@0.8-1.2');
  const plan = planTighten(words, opts({ maxGapMs: null }));
  assert.equal(reportTighten(plan), 'Tightened: removed 1 filler word.');

  const nothing = planTighten(speak('hello@0-0.4'), opts({ maxGapMs: null }));
  assert.equal(nothing.empty, true);
  assert.equal(reportTighten(nothing), 'Nothing to tighten — this script is already clean.');
});

test('every step can be switched off independently', () => {
  const words = speak(`
    um@0-0.2 I@0.3-0.4 said@0.4-0.6 I@0.7-0.8 said@0.8-1.0 yes@1.1-1.4 done@4.0-4.4
  `);

  const fillersOnly = planTighten(words, opts({ retakes: null, maxGapMs: null }));
  assert.equal(fillersOnly.retakes, 0);
  assert.equal(fillersOnly.pauses, 0);
  assert.equal(fillersOnly.maxGapMs, null);
  assert.equal(fillersOnly.capChanged, false);

  const retakesOnly = planTighten(words, opts({ fillers: null, maxGapMs: null }));
  assert.deepEqual(retakesOnly.fillerIds, []);
  assert.equal(retakesOnly.retakes, 1);
});

test('discourse markers only come along when they are asked for', () => {
  const words = speak('you@0-0.2 know@0.2-0.4 it@0.5-0.7 works@0.7-1.0');
  const off = planTighten(words, opts({ maxGapMs: null }));
  assert.deepEqual(off.fillerIds, []);

  const on = planTighten(words, opts({ maxGapMs: null, fillers: { includeDiscourseMarkers: true } }));
  assert.deepEqual(on.fillerIds, ['w0', 'w1']);
});

test('custom filler words are swept with the built-in hesitations', () => {
  const words = speak('basically@0-0.4 it@0.5-0.7 works@0.7-1.0');
  const plan = planTighten(
    words,
    opts({ maxGapMs: null, fillers: { includeDiscourseMarkers: false, customWords: ['basically'] } }),
  );
  assert.deepEqual(plan.fillerIds, ['w0']);
});
