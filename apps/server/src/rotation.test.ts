import test from 'node:test';
import assert from 'node:assert/strict';

import { displaySize, rotationOf } from './ffmpeg.ts';

/**
 * Vertical phone video is stored LANDSCAPE with a Display Matrix telling the
 * player to turn it. Reading the stored numbers and ignoring the matrix is what
 * made an imported reel come out stretched: the editor sized a landscape box
 * around a portrait picture, and the render aimed at the wrong target shape.
 *
 * These pin the rule. The values are taken from a real clip off a real phone —
 * 3840x2160 stored, rotation -90, seen as 2160x3840.
 */

test('a stream with no rotation is left exactly as it is', () => {
  assert.equal(rotationOf({ width: 1920, height: 1080 }), 0);
  assert.deepEqual(displaySize({ width: 1920, height: 1080 }), { width: 1920, height: 1080 });
});

test('-90 in a Display Matrix is a quarter turn, and swaps the axes', () => {
  const video = { width: 3840, height: 2160, side_data_list: [{ rotation: -90 }] };
  assert.equal(rotationOf(video), 270);
  assert.deepEqual(displaySize(video), { width: 2160, height: 3840 });
});

test('+90 swaps too — the axis flip is what matters, not the direction', () => {
  const video = { width: 3840, height: 2160, side_data_list: [{ rotation: 90 }] };
  assert.deepEqual(displaySize(video), { width: 2160, height: 3840 });
});

test('180 is upside down, NOT sideways, so the shape is unchanged', () => {
  const video = { width: 1920, height: 1080, side_data_list: [{ rotation: 180 }] };
  assert.equal(rotationOf(video), 180);
  assert.deepEqual(displaySize(video), { width: 1920, height: 1080 });
});

test('the older QuickTime tags.rotate spelling is honoured as well', () => {
  const video = { width: 1920, height: 1080, tags: { rotate: '270' } };
  assert.equal(rotationOf(video), 270);
  assert.deepEqual(displaySize(video), { width: 1080, height: 1920 });
});

test('a Display Matrix entry without a rotation does not break the search', () => {
  const video = { width: 1920, height: 1080, side_data_list: [{ side_data_type: 'Other' }] };
  assert.equal(rotationOf(video), 0);
});

test('garbage rotation is ignored rather than trusted', () => {
  assert.equal(rotationOf({ tags: { rotate: 'sideways' } }), 0);
  assert.equal(rotationOf({ side_data_list: [{ rotation: NaN }] }), 0);
});

test('an off-axis rotation snaps to the nearest quarter turn', () => {
  // Real files carry 90.0000001 after matrix decomposition. Rounding keeps that
  // a quarter turn instead of silently reading as "no rotation".
  assert.equal(rotationOf({ side_data_list: [{ rotation: -89.9999 }] }), 270);
});
