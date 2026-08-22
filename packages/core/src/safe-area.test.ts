import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PLATFORM_GUIDES,
  captionIsSafe,
  insetsFor,
  safeBox,
  strictestInsets,
} from './safe-area.ts';

test('every guide is a fraction of the frame, never a pixel count', () => {
  for (const g of PLATFORM_GUIDES) {
    for (const [edge, v] of Object.entries(g.insets)) {
      assert.ok(v >= 0 && v < 0.5, `${g.id}.${edge} = ${v} is not a sane fraction`);
    }
  }
});

test('"all" is the worst case of the three, not a fourth hand-typed set', () => {
  const strict = strictestInsets();
  const real = PLATFORM_GUIDES.filter((g) => g.id !== 'all');
  for (const edge of ['top', 'bottom', 'left', 'right'] as const) {
    assert.equal(strict[edge], Math.max(...real.map((g) => g.insets[edge])));
    // And it is at least as strict as any single platform.
    for (const g of real) assert.ok(strict[edge] >= g.insets[edge]);
  }
});

test('the safe box is what is left after the furniture', () => {
  const box = safeBox('reels');
  const i = insetsFor('reels');
  assert.equal(box.x, i.left);
  assert.equal(box.y, i.top);
  assert.ok(Math.abs(box.width - (1 - i.left - i.right)) < 1e-9);
  assert.ok(Math.abs(box.height - (1 - i.top - i.bottom)) < 1e-9);
});

test('an unknown platform blocks nothing rather than blocking everything', () => {
  const box = safeBox('nope' as never);
  assert.deepEqual(box, { x: 0, y: 0, width: 1, height: 1 });
});

/**
 * The case this whole file exists for: the app's own default caption anchor,
 * y = 0.85, is BELOW Instagram's caption bar. If this ever starts passing,
 * either the default moved or the guide did — both worth noticing.
 */
test("the app's default caption position is not safe on Reels", () => {
  const safe = captionIsSafe('reels', { x: 0.5, y: 0.85 }, { width: 0.8, height: 0.11 });
  assert.equal(safe, false, 'y=0.85 should collide with the Reels caption bar');
});

test('a caption lifted into the middle of the frame is safe everywhere', () => {
  assert.equal(captionIsSafe('all', { x: 0.5, y: 0.5 }, { width: 0.8, height: 0.11 }), true);
});

test('the anchor is the box CENTRE, so half the box height decides it', () => {
  const box = { width: 0.8, height: 0.2 };
  const safe = safeBox('tiktok');
  const justInside = safe.y + box.height / 2 + 1e-4;
  const justOutside = safe.y + box.height / 2 - 1e-3;
  assert.equal(captionIsSafe('tiktok', { x: 0.5, y: justInside }, box), true);
  assert.equal(captionIsSafe('tiktok', { x: 0.5, y: justOutside }, box), false);
});

test('a caption wider than the safe box fails on the sides', () => {
  assert.equal(captionIsSafe('reels', { x: 0.5, y: 0.5 }, { width: 0.99, height: 0.1 }), false);
});
