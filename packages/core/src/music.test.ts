import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BED_FADE_OUT, bedFadeOut, bedLength, bedLoops } from './music.ts';

// ── looping ───────────────────────────────────────────────────────────────────

test('a bed with no loop setting fills the program', () => {
  // The regression: a 5.6-minute track under a 6.9-minute cut used to stop dead
  // and leave the last 81 seconds silent, because absent read as false.
  const bed = { sourceDuration: 335.2 };
  assert.equal(bedLoops(bed), true);
  assert.equal(bedLength(bed, 416.4), 416.4, 'the bed covers the whole program');
});

test('loop: false is honoured — the bed stops at the file`s own length', () => {
  const bed = { sourceDuration: 335.2, loop: false };
  assert.equal(bedLoops(bed), false);
  assert.equal(bedLength(bed, 416.4), 335.2);
});

test('a bed longer than the program is cut at the program, looping or not', () => {
  assert.equal(bedLength({ sourceDuration: 600 }, 120), 120);
  assert.equal(bedLength({ sourceDuration: 600, loop: false }, 120), 120);
});

test('a user-set length wins over both caps', () => {
  assert.equal(bedLength({ sourceDuration: 335, durationSec: 60 }, 416), 60);
  // …but still cannot outrun the picture.
  assert.equal(bedLength({ sourceDuration: 335, durationSec: 900 }, 416), 416);
});

// ── the end-of-program fade ───────────────────────────────────────────────────

test('a bed that plays to the last frame is not faded', () => {
  // The regression: the default 1.5s ramp ran at the very end of the file, so an
  // export whose tail was bed-only came back with its last seconds silent while
  // the preview — which never faded — played them in full.
  assert.equal(bedFadeOut(120, 120), 0);
});

test('a bed cut short still fades, so it does not stop mid-bar', () => {
  assert.equal(bedFadeOut(60, 120), DEFAULT_BED_FADE_OUT);
});

test('reaching the end survives float drift on the output clock', () => {
  assert.equal(bedFadeOut(119.9999, 120), 0, 'a fraction of a millisecond is not a trim');
  assert.equal(bedFadeOut(119.5, 120), DEFAULT_BED_FADE_OUT, 'half a second is');
});

test('the fade never eats more than half the bed', () => {
  assert.equal(bedFadeOut(2, 120), 1);
  assert.equal(bedFadeOut(0, 120), 0);
});

test('an explicit fade is honoured even at the end of the program', () => {
  assert.equal(bedFadeOut(120, 120, 3), 3, 'a deliberate outro is still allowed');
  assert.equal(bedFadeOut(120, 120, 0), 0);
});

test('preview and render resolve one bed to one length', () => {
  // Both sides call these; this is the assertion that they cannot drift.
  const bed = { sourceDuration: 30, loop: true };
  const program = 200;
  const len = bedLength(bed, program);
  assert.equal(len, 200);
  assert.equal(bedFadeOut(len, program), 0);
});
