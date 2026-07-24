import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CAPTION_FONTS,
  CAPTION_MARGIN,
  DEFAULT_CAPTIONS,
  MIN_CAPTION_BOX,
  captionBoxFill,
  captionScale,
  clampAnchor,
  fontCss,
  fontStack,
  hexToAss,
  normalizeCaptions,
  strokeRole,
  type CaptionSettings,
} from './caption-style.ts';
import { toAss, toCues } from './captions.ts';
import { compileEdl } from './edl.ts';
import type { Transcript } from './types.ts';

function fromText(text: string): Transcript {
  const words = text.split(/\s+/).map((t, i) => ({
    id: `w${i}`,
    text: t,
    start: i * 0.5,
    end: i * 0.5 + 0.4,
  }));
  return { mediaId: 'test', duration: words.length * 0.5, words };
}

const cuesOf = (text: string, maxChars = 42) => {
  const t = fromText(text);
  return toCues(t, compileEdl(t, { padMs: 0, mergeWithinMs: 0 }), { maxChars });
};

const styleLine = (ass: string) => ass.split('\n').find((l) => l.startsWith('Style:'))!;
const dialogue = (ass: string) => ass.split('\n').filter((l) => l.startsWith('Dialogue:'));

/**
 * Read a style field BY NAME, off the file's own Format line.
 *
 * Not by index: hardcoding "BorderStyle is field 16" is both wrong (it is 15)
 * and dangerous — an assertion on the wrong column happily passes whenever the
 * neighbouring value coincides, which is exactly what happened while writing
 * these. The Format line is the schema; read it.
 */
function styleField(ass: string, name: string): string {
  const format = ass.split('\n').find((l) => l.startsWith('Format: Name'))!;
  const names = format.replace('Format: ', '').split(',').map((s) => s.trim());
  const index = names.indexOf(name);
  assert.ok(index >= 0, `no such style field: ${name}`);
  return styleLine(ass).split(',')[index].trim();
}

test('hexToAss reverses RGB into ASS BGR order', () => {
  // The whole point of the helper. Red and blue swapping is silent and looks
  // like a design choice rather than a bug.
  assert.equal(hexToAss('#FF0000'), '&H000000FF', 'red must land in the last byte');
  assert.equal(hexToAss('#0000FF'), '&H00FF0000', 'blue must land in the first colour byte');
  assert.equal(hexToAss('#FFFFFF'), '&H00FFFFFF');
  assert.equal(hexToAss('#000000'), '&H00000000');
});

test('hexToAss takes ASS alpha, where 0 is opaque', () => {
  assert.equal(hexToAss('#000000', 0x80), '&H80000000');
  assert.equal(hexToAss('#000000', 999), '&HFF000000', 'clamped, not wrapped');
});

test('a malformed colour still produces parseable ASS', () => {
  // A broken colour must not take the whole style line down with it — libass
  // would drop every caption rather than one colour.
  for (const bad of ['', 'red', '#GGG', '#12', 'rgb(1,2,3)']) {
    assert.match(hexToAss(bad), /^&H[0-9A-F]{8}$/, `bad input produced bad ASS: ${bad}`);
  }
});

test('captionScale maps the 1080p reference onto the real frame', () => {
  assert.equal(captionScale(1080), 1);
  assert.equal(captionScale(540), 0.5);
  assert.equal(captionScale(2160), 2);
  // Never scale by zero or NaN — that would collapse every glyph to nothing.
  assert.equal(captionScale(0), 1);
  assert.equal(captionScale(Number.NaN), 1);
});

test('clampAnchor keeps a dragged caption inside the frame', () => {
  assert.deepEqual(clampAnchor(-3, 9), { x: 0, y: 1 });
  assert.deepEqual(clampAnchor(0.25, 0.75), { x: 0.25, y: 0.75 });
  assert.deepEqual(clampAnchor(Number.NaN, 0.5), { x: 0.5, y: 0.5 });
});

test('every offered font has a css stack, and unknown names fall back', () => {
  for (const f of CAPTION_FONTS) assert.ok(fontCss(f.id).length > 0);
  assert.equal(fontCss('Impact'), CAPTION_FONTS[0].css, 'unknown must not yield undefined');
});

test('fontStack previews built-ins by stack and imported families by name', () => {
  // A built-in resolves exactly as fontCss does, imported list or not.
  assert.equal(fontStack('Arial', ['Bebas Neue']), fontCss('Arial'));
  // An imported family is quoted and used directly, with a sans fallback.
  assert.equal(fontStack('Bebas Neue', ['Bebas Neue']), '"Bebas Neue", sans-serif');
  // A name not in the imported list is NOT treated as custom — it falls back to
  // the sans stack rather than being quoted blind, so a stale selection is safe.
  assert.equal(fontStack('Bebas Neue', []), CAPTION_FONTS[0].css);
  // A quote in a family name cannot break out of the CSS string.
  assert.equal(fontStack('Ev"il', ['Ev"il']), '"Evil", sans-serif');
});

test('toAss scales size and position to the frame it is burning onto', () => {
  const cues = cuesOf('hello world');
  const settings = { ...DEFAULT_CAPTIONS, fontSize: 48, strokeWidth: 4, x: 0.25, y: 0.5 };

  const hd = toAss(cues, settings, { width: 1920, height: 1080 });
  assert.match(styleLine(hd), /^Style: Default,Arial,48,/);
  assert.ok(dialogue(hd)[0].includes('\\pos(480,540)'));

  // Half the height: every authored length halves, and the fractional position
  // lands on the same spot in the picture.
  const half = toAss(cues, settings, { width: 960, height: 540 });
  assert.match(styleLine(half), /^Style: Default,Arial,24,/);
  assert.ok(dialogue(half)[0].includes('\\pos(240,270)'));
});

test('toAss declares the real frame as PlayRes', () => {
  // libass scales its canvas to the frame. Lying here moves every caption.
  const ass = toAss(cuesOf('hi there'), DEFAULT_CAPTIONS, { width: 1080, height: 1920 });
  assert.ok(ass.includes('PlayResX: 1080'));
  assert.ok(ass.includes('PlayResY: 1920'));
});

test('allCaps is applied to the burned text', () => {
  const ass = toAss(cuesOf('quiet words'), { ...DEFAULT_CAPTIONS, allCaps: true });
  assert.ok(dialogue(ass)[0].includes('QUIET'));
  assert.ok(!dialogue(ass)[0].includes('quiet'));
});

test('backdrop picks the ASS border mode rather than only a colour', () => {
  const box = toAss(cuesOf('a b'), { ...DEFAULT_CAPTIONS, backdrop: 'box' });
  const plain = toAss(cuesOf('a b'), { ...DEFAULT_CAPTIONS, backdrop: 'none' });
  const shadow = toAss(cuesOf('a b'), { ...DEFAULT_CAPTIONS, backdrop: 'shadow' });

  // 3 is "opaque box", 1 is "outline, plus an optional drop shadow".
  assert.equal(styleField(box, 'BorderStyle'), '3', 'a box is a border mode, not just a colour');
  assert.equal(styleField(plain, 'BorderStyle'), '1');
  assert.equal(styleField(shadow, 'BorderStyle'), '1');

  assert.equal(styleField(plain, 'Shadow'), '0', 'no backdrop means no shadow');
  assert.notEqual(styleField(shadow, 'Shadow'), '0', 'a drop shadow needs a depth');
});

test('a box is filled with the OUTLINE colour, which is what libass actually does', () => {
  // Verified by test render, not by reading the spec: BorderStyle 3 fills from
  // OutlineColour and ignores BackColour. Coding the box as BackColour looks
  // right, renders wrong, and made the preview disagree with the burn.
  const boxed = { ...DEFAULT_CAPTIONS, backdrop: 'box' as const, strokeColor: '#3A1D00' };
  const ass = toAss(cuesOf('a b'), boxed);

  assert.equal(styleField(ass, 'OutlineColour'), hexToAss('#3A1D00'), 'the box fill');
  assert.equal(captionBoxFill(boxed), '#3A1D00', 'the preview must read the same colour');
  assert.equal(captionBoxFill({ ...boxed, backdrop: 'none' }), null, 'no box, no fill');
  assert.equal(strokeRole('box'), 'box');
  assert.equal(strokeRole('shadow'), 'outline');
});

test('braces in a word cannot swallow the caption', () => {
  // { opens an ASS override block. Unescaped, everything to the next } silently
  // disappears from the burn — no error, just missing words.
  const t: Transcript = {
    mediaId: 'x',
    duration: 2,
    words: [
      { id: 'w0', text: '{weird}', start: 0, end: 0.4 },
      { id: 'w1', text: 'word', start: 0.5, end: 0.9 },
    ],
  };
  const cues = toCues(t, compileEdl(t, { padMs: 0, mergeWithinMs: 0 }), {});
  const line = dialogue(toAss(cues, DEFAULT_CAPTIONS))[0];

  assert.ok(line.includes('\\{weird\\}'), 'braces must be escaped');
  assert.ok(line.includes('word'), 'the following word must survive');
});

test('the caption is anchored at its centre, matching the drag handle', () => {
  // Alignment 5 (centre) is what makes \pos mean the point you dropped it on.
  // Any other alignment and the caption lands offset from where you let go.
  assert.equal(styleField(toAss(cuesOf('hello'), DEFAULT_CAPTIONS), 'Alignment'), '5');
});

test('the user colour is the text colour, not the karaoke pre-roll', () => {
  const ass = toAss(cuesOf('a b'), { ...DEFAULT_CAPTIONS, color: '#00FF00', strokeColor: '#FF0000' });
  assert.equal(styleField(ass, 'PrimaryColour'), hexToAss('#00FF00'));
  assert.equal(styleField(ass, 'OutlineColour'), hexToAss('#FF0000'));
});

test('toAss defaults are usable with no settings at all', () => {
  // The sidecar .ass download calls this with nothing.
  const ass = toAss(cuesOf('one two three'));
  assert.ok(!ass.includes('undefined'), 'a missing setting leaked into the output');
  assert.ok(styleLine(ass).startsWith('Style: Default,Arial,48,&H00FFFFFF,'));
});

test('a project saved before a setting existed gets that setting filled in', () => {
  // The bug this exists to stop: `stored ?? DEFAULT_CAPTIONS` only fires when
  // there are NO stored captions. A project that saved them before
  // highlightColor existed kept its object, so the key stayed undefined — and
  // the colour swatch calls .toUpperCase() on it, which blanked the editor.
  const legacy = {
    enabled: true,
    font: 'Arial',
    fontSize: 64,
    color: '#00FF00',
    strokeColor: '#000000',
    strokeWidth: 3,
    backdrop: 'none',
    allCaps: false,
    maxChars: 42,
    x: 0.5,
    y: 0.85,
  } as Partial<CaptionSettings>;

  const merged = normalizeCaptions(legacy);
  assert.equal(merged.highlightColor, DEFAULT_CAPTIONS.highlightColor);
  assert.equal(merged.karaoke, DEFAULT_CAPTIONS.karaoke);
  assert.equal(merged.color, '#00FF00', 'what the project DID save must survive');
  assert.equal(merged.fontSize, 64);

  for (const key of Object.keys(DEFAULT_CAPTIONS)) {
    assert.notEqual(merged[key as keyof CaptionSettings], undefined, `${key} came back undefined`);
  }
});

test('an explicit undefined does not punch through to overwrite a default', () => {
  // A JSON body with an omitted field destructures to exactly this.
  const merged = normalizeCaptions({ color: undefined, fontSize: 90 });
  assert.equal(merged.color, DEFAULT_CAPTIONS.color);
  assert.equal(merged.fontSize, 90);
});

test('normalizeCaptions handles no stored settings at all', () => {
  assert.deepEqual(normalizeCaptions(undefined), DEFAULT_CAPTIONS);
  // A fresh object each time — callers spread into it and would otherwise
  // mutate the shared default.
  assert.notEqual(normalizeCaptions(undefined), DEFAULT_CAPTIONS);
});

test('libass is forbidden from wrapping, so only the caption box decides a break', () => {
  // WrapStyle 2 means "only an explicit \N breaks a line". This is what stops
  // the burn re-deciding a layout the preview already decided — and since
  // layoutCaption emits its lines as separate \pos'd events, not even a \N is
  // left for libass to act on.
  //
  // Measured against the bundled ffmpeg at 1920 wide, 40 characters of Arial
  // bold: under WrapStyle 0 a 105px line broke into two (962x193 of ink) while
  // the preview kept it whole; under WrapStyle 2 it stays one line (1883x88),
  // and at 140px it clips at exactly the frame edge — which is what the monitor
  // shows too, now that .cap-text is white-space: pre.
  const ass = toAss(cuesOf('hello there'), DEFAULT_CAPTIONS);
  assert.ok(ass.includes('WrapStyle: 2'), 'automatic wrapping must stay off');

  // And nothing may smuggle a line break into the text to work around it.
  for (const line of dialogue(ass)) assert.ok(!line.includes('\N'), 'no hard breaks emitted');
});

test('a cue never exceeds maxChars, which is how much text one caption holds', () => {
  // Not how WIDE it is drawn — the caption box answers that, and re-flows these
  // same characters onto more lines without moving one of them into a different
  // cue. The two limits are independent on purpose.
  const long = 'the quick brown fox jumps over the lazy dog and keeps on running';
  for (const cue of cuesOf(long, 24)) {
    assert.ok(cue.text.length <= 24, `cue ran to ${cue.text.length} chars: ${cue.text}`);
  }
});

test('a caption box off the wire cannot be zero, or every word gets its own line', () => {
  // boxWidth is a divisor for the wrap and boxHeight for the line step. A hand
  // -edited project file or a bad request body must not be able to hand either
  // of them a zero.
  assert.equal(normalizeCaptions({ boxWidth: 0 }).boxWidth, MIN_CAPTION_BOX.width);
  assert.equal(normalizeCaptions({ boxHeight: -3 }).boxHeight, MIN_CAPTION_BOX.height);
  assert.equal(normalizeCaptions({ boxWidth: 5 }).boxWidth, 1, 'and no wider than the frame');
  assert.equal(
    normalizeCaptions({ boxWidth: NaN }).boxWidth,
    DEFAULT_CAPTIONS.boxWidth,
    'a number that is not one falls back rather than propagating',
  );
});

test('a project saved before the caption box gets the default box, not undefined', () => {
  // The same trap highlightColor fell into: the object exists, so `stored ??
  // DEFAULT` never fires and the new key stays missing. Here it would reach
  // layoutCaption as undefined and NaN every offset in the burn.
  const stored = { enabled: true, fontSize: 64 } as Partial<CaptionSettings>;
  const merged = normalizeCaptions(stored);
  assert.equal(merged.boxWidth, DEFAULT_CAPTIONS.boxWidth);
  assert.equal(merged.boxHeight, DEFAULT_CAPTIONS.boxHeight);
});
