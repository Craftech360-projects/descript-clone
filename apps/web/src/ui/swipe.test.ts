import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verdictFor, ESCAPE, STILL } from './swipe.ts';

/**
 * The gesture that clears a banner on a phone.
 *
 * These thresholds are the whole feature: too low and a banner leaves while you
 * are scrolling past it, too high and a real flick springs back and the message
 * reads as stuck — which is the complaint the swipe was added to answer.
 */

test('a decisive throw leaves, on the side it was heading', () => {
  assert.equal(verdictFor(ESCAPE + 1, ESCAPE + 1), 'right');
  assert.equal(verdictFor(-(ESCAPE + 1), ESCAPE + 1), 'left');
  assert.equal(verdictFor(300, 300), 'right');
});

test('exactly at the threshold is not yet a throw — the test is strict', () => {
  assert.equal(verdictFor(ESCAPE, ESCAPE), 'stay');
});

test('a still finger is the tap that always dismissed', () => {
  assert.equal(verdictFor(0, 0), 'tap');
  assert.equal(verdictFor(STILL - 1, STILL - 1), 'tap');
});

test('a real drag that stops short springs back rather than dismissing', () => {
  // The case that matters: the user began a swipe and thought better of it.
  // Treating this as a tap would dismiss the very message they were reading.
  assert.equal(verdictFor(STILL, STILL), 'stay');
  assert.equal(verdictFor(40, 40), 'stay');
});

test('out and back is a drag, not a tap — travel is judged separately', () => {
  // Ends where it started, so |offset| is 0 and the tap test would pass on it.
  // The furthest point is what says a finger was dragging, and a drag returned
  // to its origin is a cancelled gesture: keep the banner.
  assert.equal(verdictFor(0, 120), 'stay');
});

test('travel alone never dismisses — only where the finger ENDED counts', () => {
  // Dragged far out, brought back to just inside the threshold: the user is
  // showing they changed their mind, and the banner has to survive it.
  assert.equal(verdictFor(ESCAPE - 1, 400), 'stay');
});
