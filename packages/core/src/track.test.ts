import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_TRACK_OPTIONS,
  crop,
  matchTemplate,
  toGray,
  trackStep,
  type Gray,
} from './track.ts';

/**
 * The tracker is tested on synthetic frames rather than on media, for the same
 * reason compileEdl is: the thing that decides where the camera looks should be
 * checkable without looking at anything.
 *
 * Each test below is a failure mode that a plausible-looking implementation has.
 * "It finds the blob in the easy case" is not one of them — SAD finds the blob
 * in the easy case too, and then loses it the moment the light changes.
 */

/** A blank field with a distinctive blob painted at (bx, by). */
function frame(width: number, height: number, bx: number, by: number, gain = 1, bias = 0): Gray {
  const data = new Float32Array(width * height);
  for (let i = 0; i < data.length; i++) data[i] = 0.5 * gain + bias;

  // Not a solid square: a solid square correlates equally well one pixel to the
  // left, so a tracker could be off by a pixel and still score 1. The gradient
  // and the notch give it a unique best position, which is what makes the
  // sub-test "found it EXACTLY" meaningful.
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const px = bx + x;
      const py = by + y;
      if (px < 0 || py < 0 || px >= width || py >= height) continue;
      const v = x < 6 && y < 6 ? 0.95 : 0.15 + 0.05 * x + 0.03 * y;
      data[py * width + px] = v * gain + bias;
    }
  }
  return { data, width, height };
}

const OPTS = { radius: 20, minScore: 0.5 };

test('luma comes off RGBA on the same coefficients the grade uses', () => {
  const rgba = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255]);
  const gray = toGray(rgba, 2, 1);
  assert.ok(Math.abs(gray.data[0] - 1) < 1e-6);
  assert.equal(gray.data[1], 0);
});

test('a marked object is found exactly where it moved to', () => {
  const first = frame(120, 90, 40, 30);
  const template = crop(first, { x: 40, y: 30, width: 12, height: 12 });
  const next = frame(120, 90, 47, 36);

  const m = matchTemplate(next, template, { x: 40, y: 30 }, OPTS.radius);
  assert.equal(m.x, 47);
  assert.equal(m.y, 36);
  assert.ok(m.score > 0.99, `${m.score}`);
});

test('a brightness change does not break the follow — the whole reason for NCC', () => {
  // Someone turning towards a window is the ordinary case, not the hard one. A
  // sum-of-differences tracker scores absolute brightness and loses the subject
  // here; correlation scores shape and does not notice.
  const first = frame(120, 90, 40, 30);
  const template = crop(first, { x: 40, y: 30, width: 12, height: 12 });
  const darker = frame(120, 90, 46, 33, 0.55, 0.1);

  const m = matchTemplate(darker, template, { x: 40, y: 30 }, OPTS.radius);
  assert.equal(m.x, 46);
  assert.equal(m.y, 33);
  assert.ok(m.score > 0.95, `a half-stop change should barely dent the score: ${m.score}`);
});

test('the search is LOCAL, so a second identical object is not stolen', () => {
  // Two faces in a two-shot correlate equally well. A whole-frame search hops
  // between them and scores beautifully doing it; the neighbourhood encodes the
  // one true fact — the subject did not teleport between two samples.
  const first = frame(200, 90, 30, 30);
  const template = crop(first, { x: 30, y: 30, width: 12, height: 12 });

  const both = frame(200, 90, 34, 30);
  const decoy = frame(200, 90, 150, 30);
  for (let i = 0; i < both.data.length; i++) both.data[i] = Math.max(both.data[i], decoy.data[i]);

  const m = matchTemplate(both, template, { x: 30, y: 30 }, 20);
  assert.equal(m.x, 34, 'followed the near one, not the identical far one');
});

test('a featureless template is refused rather than answered at random', () => {
  // A patch of sky correlates with everything equally; there is no best window
  // to find, and any answer would be noise presented as a measurement.
  const flat: Gray = { data: new Float32Array(64 * 64).fill(0.4), width: 64, height: 64 };
  const template = crop(flat, { x: 10, y: 10, width: 12, height: 12 });
  const m = matchTemplate(flat, template, { x: 10, y: 10 }, 8);
  assert.equal(m.score, 0);
  assert.equal(m.x, 10);
  assert.equal(m.y, 10);
});

test('losing the subject holds position instead of inventing one', () => {
  const first = frame(120, 90, 40, 30);
  const template = crop(first, { x: 40, y: 30, width: 12, height: 12 });
  // The object has left: nothing in this frame resembles it.
  const gone: Gray = { data: new Float32Array(120 * 90).fill(0.5), width: 120, height: 90 };

  const step = trackStep(gone, template, { x: 40, y: 30, lost: 0 }, OPTS);
  assert.ok(step.held, 'a bad match must be reported, not smoothed over');
  assert.equal(step.x, 40);
  assert.equal(step.y, 30);
});

test('the template is never re-taken, so a follow cannot drift', () => {
  // Each step is matched against the ORIGINAL mark. Re-taking the template each
  // frame bakes every step's small error into the next step's target, and the
  // tracker walks confidently off its subject. Twenty steps of a slow drift-prone
  // move must still land on the truth.
  let state = { x: 20, y: 20, lost: 0 };
  const template = crop(frame(200, 140, 20, 20), { x: 20, y: 20, width: 12, height: 12 });

  for (let i = 1; i <= 20; i++) {
    const truth = { x: 20 + i * 3, y: 20 + i * 2 };
    const step = trackStep(frame(200, 140, truth.x, truth.y), template, state, OPTS);
    assert.equal(step.x, truth.x, `step ${i}`);
    assert.equal(step.y, truth.y, `step ${i}`);
    state = { x: step.x, y: step.y, lost: 0 };
  }
});

test('a subject faster than the radius is lost, not chased across the frame', () => {
  // Stated as a property because it is the tracker's real limit: `radius` is a
  // speed budget, and a cut or a whip pan exceeds it by design. Failing here is
  // correct — it is the caller's cue to say so rather than to emit a path that
  // quietly points at the background.
  const template = crop(frame(200, 140, 20, 20), { x: 20, y: 20, width: 12, height: 12 });
  const jumped = frame(200, 140, 150, 120);
  const step = trackStep(jumped, template, { x: 20, y: 20, lost: 0 }, { radius: 10, minScore: 0.5 });
  assert.ok(step.held);
});

test('crop is clamped to the image rather than reading past its end', () => {
  const image = frame(40, 30, 5, 5);
  const box = crop(image, { x: 34, y: 26, width: 12, height: 12 });
  assert.equal(box.width, 6);
  assert.equal(box.height, 4);
  assert.equal(box.data.length, 24);
});

test('the defaults are the ones the app ships', () => {
  assert.equal(DEFAULT_TRACK_OPTIONS.minScore, 0.5);
  assert.ok(DEFAULT_TRACK_OPTIONS.radius > 0);
});
