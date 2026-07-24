import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTION_LINE_HEIGHT,
  layoutCaption,
  measureCaption,
  type LayoutFrame,
} from './caption-layout.ts';
import { DEFAULT_CAPTIONS, type CaptionSettings } from './caption-style.ts';

const FRAME: LayoutFrame = { width: 1920, height: 1080 };

const settings = (patch: Partial<CaptionSettings> = {}): CaptionSettings => ({
  ...DEFAULT_CAPTIONS,
  ...patch,
});

const SENTENCE = 'the quick brown fox jumps over the lazy dog'.split(' ');

test('measureCaption scales with the type size', () => {
  const at48 = measureCaption('hello', 'Arial', 48);
  const at96 = measureCaption('hello', 'Arial', 96);
  assert.ok(Math.abs(at96 - at48 * 2) < 1e-9, 'twice the size is twice the width');
});

test('measureCaption charges narrow glyphs less than wide ones', () => {
  // The whole reason for a width table rather than a character count: "IIII" and
  // "WWWW" are the same length and nothing like the same width, and a caption
  // box that treated them alike would wrap one far too early and the other far
  // too late.
  assert.ok(
    measureCaption('llll', 'Arial', 48) < measureCaption('WWWW', 'Arial', 48) / 2,
    'four l must be less than half of four W',
  );
});

test('measureCaption is fixed-pitch for the mono face', () => {
  assert.equal(
    measureCaption('ll', 'Courier New', 100),
    measureCaption('WW', 'Courier New', 100),
  );
});

test('an unknown family falls back rather than measuring nothing', () => {
  // An imported font has no table here. Falling back to sans is a few percent
  // out; returning 0 would put every word of every cue on its own line.
  assert.equal(measureCaption('hello', 'Bebas Neue', 48), measureCaption('hello', 'Arial', 48));
});

test('a wide box holds the whole cue on one line', () => {
  const lines = layoutCaption(SENTENCE, settings({ boxWidth: 1 }), FRAME);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, SENTENCE.join(' '));
  assert.equal(lines[0].dy, 0, 'a single line sits on the anchor');
});

test('narrowing the box folds the SAME words onto more lines', () => {
  // The property the whole feature rests on: the box changes the shape of a
  // caption, never its content. Re-chunking the transcript is maxChars' job and
  // this must not touch it.
  const wide = layoutCaption(SENTENCE, settings({ boxWidth: 1 }), FRAME);
  const narrow = layoutCaption(SENTENCE, settings({ boxWidth: 0.3 }), FRAME);

  assert.ok(narrow.length > wide.length, 'a narrower box must break more');
  assert.equal(
    narrow.map((l) => l.text).join(' '),
    wide.map((l) => l.text).join(' '),
    'not one character may differ',
  );
  assert.equal(narrow[narrow.length - 1].to, SENTENCE.length, 'every word is placed');
});

test('word ranges are contiguous and cover the cue exactly', () => {
  // The burn slices karaokeSpans with these, so a gap would drop a word from the
  // render and an overlap would highlight one twice.
  const lines = layoutCaption(SENTENCE, settings({ boxWidth: 0.35 }), FRAME);
  assert.equal(lines[0].from, 0);
  for (let i = 1; i < lines.length; i++) assert.equal(lines[i].from, lines[i - 1].to);
  assert.equal(lines[lines.length - 1].to, SENTENCE.length);
  for (const line of lines) {
    assert.equal(line.text, SENTENCE.slice(line.from, line.to).join(' '));
  }
});

test('no line is wider than the box unless one word is', () => {
  const s = settings({ boxWidth: 0.4 });
  const max = s.boxWidth * FRAME.width;
  for (const line of layoutCaption(SENTENCE, s, FRAME)) {
    if (line.to - line.from === 1) continue; // a single word overflows rather than being split
    assert.ok(line.width <= max, `"${line.text}" is ${line.width}px in a ${max}px box`);
  }
});

test('a word wider than the box stays whole and overflows', () => {
  // Matching the burn, which under WrapStyle 2 lets an over-long line run off
  // the frame. Hyphenating here would invent text the transcript does not have.
  const lines = layoutCaption(['supercalifragilistic'], settings({ boxWidth: 0.1 }), FRAME);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].text, 'supercalifragilistic');
});

test('a short box packs lines at the natural leading and never overlaps them', () => {
  const s = settings({ boxWidth: 0.3, boxHeight: 0.04 });
  const lines = layoutCaption(SENTENCE, s, FRAME);
  assert.ok(lines.length >= 2);
  const step = lines[1].dy - lines[0].dy;
  assert.ok(Math.abs(step - s.fontSize * CAPTION_LINE_HEIGHT) < 1e-9, 'floored at the leading');
});

test('a taller box spreads the lines apart', () => {
  const short = layoutCaption(SENTENCE, settings({ boxWidth: 0.3, boxHeight: 0.04 }), FRAME);
  const tall = layoutCaption(SENTENCE, settings({ boxWidth: 0.3, boxHeight: 0.6 }), FRAME);
  assert.equal(short.length, tall.length, 'height must not change where lines break');
  assert.ok(tall[1].dy - tall[0].dy > short[1].dy - short[0].dy);
});

test('lines are centred on the anchor', () => {
  // ASS Alignment 5 anchors at the block's centre, so the offsets have to sum to
  // zero or the caption drifts up or down as it gains lines.
  const lines = layoutCaption(SENTENCE, settings({ boxWidth: 0.3 }), FRAME);
  const sum = lines.reduce((t, l) => t + l.dy, 0);
  assert.ok(Math.abs(sum) < 1e-9, `offsets sum to ${sum}`);
});

test('the box is resolution independent', () => {
  // The same settings on a 4K master and a 720p proxy must break in the same
  // places — that is what lets the monitor, a few hundred pixels wide, preview a
  // render truthfully.
  const s = settings({ boxWidth: 0.35 });
  const uhd = layoutCaption(SENTENCE, s, { width: 3840, height: 2160 });
  const small = layoutCaption(SENTENCE, s, { width: 480, height: 270 });
  assert.deepEqual(
    uhd.map((l) => l.text),
    small.map((l) => l.text),
  );
  assert.ok(Math.abs(uhd[1].dy / small[1].dy - 8) < 1e-9, 'offsets scale with the frame');
});

test('ALL CAPS is measured in caps', () => {
  // Uppercase is wider, so a box that fits a cue lowercase can need another line
  // for the same cue shouting. Measuring the stored text would wrap in one place
  // and draw in another.
  const s = settings({ boxWidth: 0.3, allCaps: true });
  const caps = layoutCaption(SENTENCE, s, FRAME);
  const lower = layoutCaption(SENTENCE, { ...s, allCaps: false }, FRAME);
  assert.ok(caps.length >= lower.length);
});

test('the default box leaves a full-length cue on one line', () => {
  // Turning captions on must not reshape anything: the defaults have to produce
  // the single line this app drew before the box existed.
  const cue = 'a caption of about forty two characters'.split(' ');
  assert.equal(layoutCaption(cue, settings(), FRAME).length, 1);
});

test('no words is no lines', () => {
  assert.deepEqual(layoutCaption([], settings(), FRAME), []);
});
