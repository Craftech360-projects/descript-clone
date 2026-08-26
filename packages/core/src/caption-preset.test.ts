import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyCaptionStyle,
  BUILT_IN_CAPTION_STYLES,
  captionStyleSummary,
  captureCaptionStyle,
  matchesCaptionStyle,
  MAX_CAPTION_STYLES,
  MAX_STYLE_NAME,
  normalizeCaptionStyles,
  removeCaptionStyle,
  saveCaptionStyle,
  styleKey,
  type CaptionStyle,
} from './caption-preset.ts';
import { CAPTION_FONTS, DEFAULT_CAPTIONS, type CaptionSettings } from './caption-style.ts';
import { captionIsSafe } from './safe-area.ts';

const style = (name: string, over: Partial<CaptionSettings> = {}): CaptionStyle =>
  captureCaptionStyle(name, { ...DEFAULT_CAPTIONS, ...over })!;

test('every built-in names a font the render machine can actually resolve', () => {
  // The whole reason CAPTION_FONTS is three faces long. A preset reaching past
  // it would preview correctly and fall back silently in the container.
  const allowed = new Set(CAPTION_FONTS.map((f) => f.id));
  for (const s of BUILT_IN_CAPTION_STYLES) {
    assert.ok(allowed.has(s.settings.font), `${s.name} uses ${s.settings.font}`);
  }
});

test('every built-in clears the platform furniture on all three platforms', () => {
  // safe-area.ts names this app's own default y of 0.85 as the caption that
  // lands under the Reels caption bar. A preset shipped for reels must not.
  for (const s of BUILT_IN_CAPTION_STYLES) {
    const ok = captionIsSafe(
      'all',
      { x: s.settings.x, y: s.settings.y },
      { width: s.settings.boxWidth, height: s.settings.boxHeight },
    );
    assert.ok(ok, `${s.name} at y=${s.settings.y} is under someone's furniture`);
  }
});

test('the built-ins are three different looks, not three sizes of one', () => {
  const looks = new Set(
    BUILT_IN_CAPTION_STYLES.map((s) => `${s.settings.backdrop}/${s.settings.karaoke}/${s.settings.allCaps}`),
  );
  assert.equal(looks.size, BUILT_IN_CAPTION_STYLES.length);
});

test('applying a style never switches captions on or off', () => {
  // The one field that is not an appearance. A picker that turned captions off
  // because the look was captured with them off is a trap you fall into once.
  const captured = style('Bold', { enabled: false, fontSize: 90 });

  const on = applyCaptionStyle({ ...DEFAULT_CAPTIONS, enabled: true }, captured);
  assert.equal(on.enabled, true);
  assert.equal(on.fontSize, 90);

  const off = applyCaptionStyle({ ...DEFAULT_CAPTIONS, enabled: false }, { ...captured, settings: { ...captured.settings, enabled: true } });
  assert.equal(off.enabled, false);
});

test('a style survives the round trip through storage', () => {
  const saved = style('Podcast', { fontSize: 52, allCaps: true, backdrop: 'shadow' });
  const list = saveCaptionStyle([], saved);

  const back = normalizeCaptionStyles(JSON.parse(JSON.stringify(list)));
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'Podcast');
  assert.deepEqual(back[0].settings, saved.settings);
  assert.ok(matchesCaptionStyle(applyCaptionStyle(DEFAULT_CAPTIONS, back[0]), saved));
});

test('saving the same name twice replaces rather than duplicates', () => {
  let list = saveCaptionStyle([], style('Series', { fontSize: 40 }));
  list = saveCaptionStyle(list, style('  series  ', { fontSize: 70 }));

  assert.equal(list.length, 1);
  assert.equal(list[0].settings.fontSize, 70);
  // The display name follows the latest save; the key is what matched.
  assert.equal(list[0].name, 'series');
});

test('a name that is only whitespace is not a style', () => {
  assert.equal(captureCaptionStyle('   ', DEFAULT_CAPTIONS), null);
  assert.equal(captureCaptionStyle('', DEFAULT_CAPTIONS), null);
});

test('names are trimmed, collapsed and bounded', () => {
  const s = captureCaptionStyle(`  my   ${'x'.repeat(60)}  `, DEFAULT_CAPTIONS)!;
  assert.equal(s.name.length, MAX_STYLE_NAME);
  assert.equal(s.id, styleKey(s.name));
  assert.ok(!s.name.includes('   '));
});

test('the saved list is capped, and the cap drops the oldest', () => {
  let list: CaptionStyle[] = [];
  for (let i = 0; i < MAX_CAPTION_STYLES + 3; i++) list = saveCaptionStyle(list, style(`s${i}`));

  assert.equal(list.length, MAX_CAPTION_STYLES);
  // The save you just made must still be there — evicting the newest reads as
  // the feature being broken.
  assert.equal(list[list.length - 1].name, `s${MAX_CAPTION_STYLES + 2}`);
  assert.equal(list[0].name, 's3');
});

test('junk out of storage produces an empty list, not a crash', () => {
  assert.deepEqual(normalizeCaptionStyles(null), []);
  assert.deepEqual(normalizeCaptionStyles('nope'), []);
  assert.deepEqual(normalizeCaptionStyles([1, 'x', null, {}]), []);
  assert.deepEqual(normalizeCaptionStyles([{ name: '   ' }]), []);
});

test('a stored style missing fields is filled from the defaults, not left undefined', () => {
  // The bug normalizeCaptions exists for: a colour swatch calls .toUpperCase()
  // on highlightColor, and a throw during render unmounts the whole editor.
  const [only] = normalizeCaptionStyles([{ name: 'Old', settings: { fontSize: 60 } }]);
  assert.equal(only.settings.fontSize, 60);
  assert.equal(only.settings.highlightColor, DEFAULT_CAPTIONS.highlightColor);
  assert.equal(only.settings.backdrop, DEFAULT_CAPTIONS.backdrop);
});

test('duplicate keys in storage collapse to the first', () => {
  const list = normalizeCaptionStyles([
    { name: 'Reel', settings: { fontSize: 30 } },
    { name: 'reel', settings: { fontSize: 90 } },
  ]);
  assert.equal(list.length, 1);
  assert.equal(list[0].settings.fontSize, 30);
});

test('matching ignores enabled and nothing else', () => {
  const s = style('X', { fontSize: 44 });
  assert.ok(matchesCaptionStyle({ ...s.settings, enabled: !s.settings.enabled }, s));
  assert.ok(!matchesCaptionStyle({ ...s.settings, fontSize: 45 }, s));
  assert.ok(!matchesCaptionStyle({ ...s.settings, y: s.settings.y + 0.01 }, s));
});

test('removing a style leaves the others alone', () => {
  let list = saveCaptionStyle([], style('a'));
  list = saveCaptionStyle(list, style('b'));
  assert.deepEqual(removeCaptionStyle(list, styleKey('a')).map((s) => s.name), ['b']);
  assert.equal(removeCaptionStyle(list, 'nope').length, 2);
});

test('the summary names what you would recognise the look by', () => {
  assert.equal(
    captionStyleSummary(BUILT_IN_CAPTION_STYLES[0]),
    'Arial · 44px · ALL CAPS · 6px outline · word highlight',
  );
  assert.equal(captionStyleSummary(BUILT_IN_CAPTION_STYLES[1]), 'Arial · 36px · box');
});
