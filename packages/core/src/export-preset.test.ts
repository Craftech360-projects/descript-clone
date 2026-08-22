import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_PRESETS,
  STREAMING_LUFS,
  loudnessStage,
  overBy,
  presetFor,
} from './export-preset.ts';

test('an unknown preset falls back to leaving the project alone', () => {
  const p = presetFor('not-a-platform');
  assert.equal(p.id, 'source');
  assert.equal(p.size, null);
  assert.equal(p.lufs, null);
});

test('the platform presets are all vertical, because that is what they are for', () => {
  for (const p of EXPORT_PRESETS) {
    if (p.id === 'source') continue;
    assert.ok(p.size, `${p.id} must name a size`);
    assert.ok(p.size!.height > p.size!.width, `${p.id} should be portrait`);
  }
});

test('every normalising preset aims at the streaming target', () => {
  for (const p of EXPORT_PRESETS) {
    if (p.lufs === null) continue;
    assert.equal(p.lufs, STREAMING_LUFS);
    // A target louder than -9 or quieter than -24 is a typo, not a choice.
    assert.ok(p.lufs < -9 && p.lufs > -24);
    assert.ok(p.truePeak <= -1, 'a true-peak ceiling at or above -1 invites clipping');
  }
});

test('over-length is reported only when it is real', () => {
  assert.equal(overBy('reels', 60), null);
  assert.equal(overBy('reels', 90), null, 'exactly at the limit still fits');
  assert.equal(Math.round(overBy('reels', 95)!), 5);
});

test('a preset with no limit never reports over-length', () => {
  assert.equal(overBy('source', 60 * 60), null);
});

test('a nonsense duration is not reported as over-length', () => {
  assert.equal(overBy('reels', NaN), null);
  assert.equal(overBy('reels', Infinity), null);
});

test('the loudness stage is emitted only where a target exists', () => {
  assert.equal(loudnessStage('source'), null);
  const stage = loudnessStage('reels');
  assert.ok(stage && stage.startsWith('loudnorm='));
  assert.match(stage!, /I=-14/);
  assert.match(stage!, /TP=-1\.5/);
});

test('the stage is a single filter, so it can be spliced into a chain', () => {
  const stage = loudnessStage('tiktok')!;
  assert.ok(!stage.includes(','), 'must not smuggle in a second filter');
  assert.ok(!stage.includes(';'), 'must not smuggle in a second chain');
});
