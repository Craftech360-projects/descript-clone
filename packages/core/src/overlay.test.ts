import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_OVERLAY_EASE,
  DEFAULT_OVERLAY_SEC,
  FULL_FRAME_BOX,
  MAX_OVERLAYS,
  MAX_SUGGESTED_OVERLAY_SEC,
  MIN_OVERLAY_SEC,
  addOverlay,
  createOverlay,
  easeOf,
  isEmptyOverlayTrack,
  normalizeOverlays,
  overlayFade,
  overlayFilterLines,
  overlayMotion,
  overlaysAt,
  overlaysToOutput,
  removeOverlay,
  sampleOverlay,
  slideTravel,
  suggestWindow,
  updateOverlay,
  type ImageOverlay,
} from './overlay.ts';

/**
 * An image overlay has TWO implementations of one function — sampleOverlay,
 * which the monitor composites with, and an `overlay` filter's x/y/alpha, which
 * ffmpeg renders with. If they drift the app shows a composite it does not ship.
 *
 * So the centrepiece here is the parity test at the bottom: the emitted
 * expression is parsed and run against the same instants sampleOverlay is asked
 * about, and the two are compared as PIXELS rather than as coefficients —
 * agreeing on the numbers while disagreeing on what they index is exactly the
 * bug worth catching. evalExpr covers only the subset the emitter can produce,
 * so a new function in the emitter fails loudly here rather than slipping past.
 */

const HD = { width: 1920, height: 1080, fps: 30 };

const ov = (over: Partial<ImageOverlay> = {}): ImageOverlay => ({
  id: 'o1',
  assetId: 'a1',
  start: 2,
  end: 8,
  transition: 'fade',
  ease: 1,
  box: { ...FULL_FRAME_BOX },
  fit: 'cover',
  opacity: 1,
  ...over,
});

// ── the ramps ─────────────────────────────────────────────────────────────────

test('an overlay is inert outside its own region', () => {
  const o = ov();
  assert.equal(overlayFade(o, 0), 0);
  assert.equal(overlayFade(o, 1.99), 0);
  assert.equal(overlayFade(o, 8), 0, 'the region is half-open, so it is off at end');
  assert.equal(overlayFade(o, 100), 0);
  assert.equal(sampleOverlay(o, 0), null);
});

test('the opacity ramp is LINEAR, because ffmpeg fade is', () => {
  // This is the load-bearing difference from frame-track's smoothstep, and the
  // reason it is pinned: `fade` has no shaping parameter, so a preview that
  // eased its dissolve would disagree with every exported file. Measured
  // against ffmpeg 8.0, the midpoint of a fade reads 53% — a straight line.
  const o = ov({ start: 2, end: 8, ease: 1 });
  assert.ok(Math.abs(overlayFade(o, 2.25) - 0.25) < 1e-9);
  assert.ok(Math.abs(overlayFade(o, 2.5) - 0.5) < 1e-9);
  assert.ok(Math.abs(overlayFade(o, 2.75) - 0.75) < 1e-9);
  // Equal steps produce equal deltas, which is what "linear" means and what
  // smoothstep would break.
  const a = overlayFade(o, 2.2) - overlayFade(o, 2.1);
  const b = overlayFade(o, 2.6) - overlayFade(o, 2.5);
  assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
});

test('the motion ramp is NOT linear — it starts and ends at rest', () => {
  const o = ov({ transition: 'slide-left' });
  const eps = 0.05;
  const atStart = overlayMotion(o, 2 + eps) - overlayMotion(o, 2);
  const atMiddle = overlayMotion(o, 2.5 + eps) - overlayMotion(o, 2.5);
  assert.ok(atMiddle > atStart * 4, `${atMiddle} vs ${atStart}`);
});

test('a “cut” transition ignores its ease entirely', () => {
  const o = ov({ transition: 'cut', ease: 2 });
  assert.equal(easeOf(o), 0);
  assert.equal(overlayFade(o, 1.999), 0);
  assert.equal(overlayFade(o, 2), 1, 'full strength on its first frame');
  assert.equal(overlayFade(o, 7.999), 1, 'and on its last');
  assert.equal(overlayFade(o, 8), 0);
});

test('ramps shrink to fit rather than overlapping in a short overlay', () => {
  // Two 1s ramps in a 1s region would each be at 50% in the middle; multiplied
  // they would darken the peak to 25% and the image would never reach full.
  // min() makes it a triangle that peaks at exactly 0.5 once, at the midpoint.
  const o = ov({ start: 0, end: 1, ease: 1 });
  assert.equal(easeOf(o), 0.5, 'clamped to half the region');
  assert.ok(Math.abs(overlayFade(o, 0.5) - 1) < 1e-9, 'reaches full at the middle');
  assert.ok(Math.abs(overlayFade(o, 0.25) - 0.5) < 1e-9);
  assert.ok(Math.abs(overlayFade(o, 0.75) - 0.5) < 1e-9);
});

test('peak opacity scales the ramp rather than replacing it', () => {
  const o = ov({ opacity: 0.5, ease: 1 });
  assert.ok(Math.abs(sampleOverlay(o, 5)!.opacity - 0.5) < 1e-9, 'held at the peak');
  assert.ok(Math.abs(sampleOverlay(o, 2.5)!.opacity - 0.25) < 1e-9, 'half way to the peak');
});

// ── slides ────────────────────────────────────────────────────────────────────

test('a slide starts COMPLETELY off-frame, measured from the far edge', () => {
  // A fixed travel would leave a sliver of an off-centre image parked on the
  // frame before the move began.
  const inset = { x: 0.6, y: 0.1, width: 0.3, height: 0.3 };
  const near = (got: number, want: number) => assert.ok(Math.abs(got - want) < 1e-9, `${got} vs ${want}`);
  near(slideTravel(ov({ transition: 'slide-left', box: inset })).dx, -0.9);
  near(slideTravel(ov({ transition: 'slide-right', box: inset })).dx, 0.4);
  near(slideTravel(ov({ transition: 'slide-up', box: inset })).dy, -0.4);
  near(slideTravel(ov({ transition: 'slide-down', box: inset })).dy, 0.9);
});

test('a slide is home across the middle and away at the edges', () => {
  const o = ov({ transition: 'slide-left', start: 2, end: 8, ease: 1 });
  assert.ok(Math.abs(sampleOverlay(o, 5)!.dx) < 1e-9, 'home');
  // Just inside the region the image is still essentially off-frame.
  assert.ok(sampleOverlay(o, 2.02)!.dx < -0.95);
  assert.ok(sampleOverlay(o, 7.98)!.dx < -0.95, 'and it leaves the way it came');
});

test('fade and cut do not move the image', () => {
  for (const transition of ['fade', 'cut'] as const) {
    const s = sampleOverlay(ov({ transition }), 5)!;
    assert.equal(s.dx, 0);
    assert.equal(s.dy, 0);
  }
});

// ── coercion ──────────────────────────────────────────────────────────────────

test('an overlay with no asset is dropped — it is the one field with no fallback', () => {
  assert.equal(normalizeOverlays([{ start: 1, end: 3 }]).length, 0);
  assert.equal(normalizeOverlays([{ assetId: '', start: 1, end: 3 }]).length, 0);
  assert.equal(normalizeOverlays([{ assetId: 'a', start: 1, end: 3 }]).length, 1);
});

test('garbage is coerced per field, not per record', () => {
  const [o] = normalizeOverlays([
    { assetId: 'a', start: 1, end: 3, ease: NaN, opacity: 'loud', fit: 'squish', transition: 'explode' },
  ]);
  assert.equal(o.ease, DEFAULT_OVERLAY_EASE);
  assert.equal(o.opacity, 1);
  assert.equal(o.fit, 'cover');
  assert.equal(o.transition, 'fade');
  assert.deepEqual(o.box, FULL_FRAME_BOX);
});

test('a box is clamped INTO the frame, not merely range-checked', () => {
  const [o] = normalizeOverlays([{ assetId: 'a', start: 0, end: 2, box: { x: 0.8, y: 0.9, width: 0.5, height: 0.4 } }]);
  assert.ok(o.box.x + o.box.width <= 1 + 1e-9, 'right edge stays on the frame');
  assert.ok(o.box.y + o.box.height <= 1 + 1e-9, 'bottom edge too');
});

test('zero-length overlays are dropped, and the rest come out in time order', () => {
  const out = normalizeOverlays([
    { assetId: 'a', id: 'late', start: 9, end: 10 },
    { assetId: 'a', id: 'empty', start: 4, end: 4 },
    { assetId: 'a', id: 'early', start: 1, end: 2 },
  ]);
  assert.deepEqual(out.map((o) => o.id), ['early', 'late']);
});

test('overlaps SURVIVE — unlike push-ins, two images at once is a cross-dissolve', () => {
  const out = normalizeOverlays([
    { assetId: 'a', id: 'first', start: 0, end: 5 },
    { assetId: 'b', id: 'second', start: 4, end: 9 },
  ]);
  assert.equal(out.length, 2);
  assert.deepEqual(overlaysAt(out, 4.5).map((o) => o.id), ['first', 'second'], 'later draws on top');
});

test('the overlay count is bounded at the one funnel everything crosses', () => {
  const many = Array.from({ length: MAX_OVERLAYS + 20 }, (_, i) => ({
    assetId: 'a',
    id: `o${i}`,
    start: i,
    end: i + 0.5,
  }));
  assert.equal(normalizeOverlays(many).length, MAX_OVERLAYS);
  // addOverlay refuses rather than silently trimming, so the caller's no-op test
  // (and therefore undo) needs no special case.
  const full = normalizeOverlays(many);
  assert.equal(addOverlay(full, createOverlay('x', 'a', 1, 3)), full);
});

test('normalizeOverlays is total on rubbish', () => {
  assert.deepEqual(normalizeOverlays(undefined), []);
  assert.deepEqual(normalizeOverlays('nope'), []);
  assert.deepEqual(normalizeOverlays([null, 7, 'x']), []);
});

// ── editing ───────────────────────────────────────────────────────────────────

test('an overlay is never created shorter than the floor', () => {
  // A word is ~0.3s and an image on screen for 0.3s is a flash, not a cutaway.
  const o = createOverlay('o', 'a', 5, 5.2);
  assert.ok(Math.abs(o.end - o.start - MIN_OVERLAY_SEC) < 1e-9, `${o.end - o.start}`);
});

test('update keeps the list in time order', () => {
  const list = [createOverlay('a', 'i', 0, 2), createOverlay('b', 'i', 5, 7)];
  const moved = updateOverlay(list, 'b', { start: 0.5, end: 1.5 });
  assert.deepEqual(moved.map((o) => o.id), ['a', 'b']);
  const back = updateOverlay(moved, 'a', { start: 9, end: 11 });
  assert.deepEqual(back.map((o) => o.id), ['b', 'a']);
});

test('remove is by id and leaves the rest alone', () => {
  const list = [createOverlay('a', 'i', 0, 2), createOverlay('b', 'i', 5, 7)];
  assert.deepEqual(removeOverlay(list, 'a').map((o) => o.id), ['b']);
  assert.equal(removeOverlay(list, 'nope').length, 2);
});

test('an empty track is one that would composite nothing', () => {
  assert.ok(isEmptyOverlayTrack([]));
  assert.ok(isEmptyOverlayTrack([ov({ opacity: 0 })]));
  assert.ok(!isEmptyOverlayTrack([ov()]));
});

// ── how long an image should stay up ──────────────────────────────────────────

test('a single word does not get a single word’s worth of picture', () => {
  const { start, end } = suggestWindow([{ start: 10, end: 10.3 }], 600);
  assert.equal(start, 10, 'arrives AS the word is said');
  assert.equal(end - start, DEFAULT_OVERLAY_SEC);
  assert.ok(end - start >= MIN_OVERLAY_SEC);
});

test('a long selection is covered rather than truncated to the default', () => {
  const { start, end } = suggestWindow([{ start: 10, end: 14 }], 600);
  assert.equal(start, 10);
  assert.equal(end, 14, 'runs to the end of the words it was aimed at');
});

test('the suggestion never runs past the media', () => {
  const { end } = suggestWindow([{ start: 9.8, end: 10 }], 10);
  assert.ok(end <= 10, `${end}`);
});

test('an over-eager request is capped', () => {
  const { start, end } = suggestWindow([{ start: 0, end: 0.2 }], 600, 99);
  assert.equal(end - start, MAX_SUGGESTED_OVERLAY_SEC);
});

// ── the source → output remap ─────────────────────────────────────────────────

const identity = (t: number) => t;

test('an overlay whose middle survived is shortened, not dropped', () => {
  // The edit cut the first second of a 2s insert: it should still play across
  // what is left rather than vanishing.
  const map = (t: number) => (t < 3 ? null : t - 3);
  const [out] = overlaysToOutput([ov({ start: 2, end: 8, ease: 1 })], map, (from, to) =>
    from < to ? 0 : 5,
  );
  assert.equal(out.start, 0);
  assert.equal(out.end, 5);
  assert.ok(out.ease < 1, 'the ease shrank with the region');
  assert.ok(out.ease <= (out.end - out.start) / 2);
});

test('an overlay whose word was cut is dropped entirely', () => {
  // The one case that matters most: the user deleted the very word the image
  // was illustrating, so the image has nothing left to illustrate.
  assert.deepEqual(overlaysToOutput([ov()], () => null), []);
});

test('the remap preserves everything that is not a time', () => {
  const source = ov({ transition: 'slide-up', fit: 'contain', opacity: 0.4, assetId: 'pic', wordText: 'robot' });
  const [out] = overlaysToOutput([source], identity);
  assert.equal(out.transition, 'slide-up');
  assert.equal(out.fit, 'contain');
  assert.equal(out.opacity, 0.4);
  assert.equal(out.assetId, 'pic');
  assert.equal(out.wordText, 'robot');
});

test('remapped overlays come out in output order', () => {
  // A reordering edit could map a later source overlay to an earlier output
  // time; the chain is built in array order, so the sort is what keeps draw
  // order and time order the same thing.
  const out = overlaysToOutput(
    [ov({ id: 'a', start: 2, end: 4 }), ov({ id: 'b', start: 6, end: 8 })],
    (t) => 10 - t,
  );
  assert.ok(out[0].start <= out[1].start);
});

// ── the filtergraph ───────────────────────────────────────────────────────────

test('no images means no lines and no inputs at all', () => {
  const plan = overlayFilterLines([], '[vbase]', HD, 2);
  assert.deepEqual(plan.lines, []);
  assert.deepEqual(plan.inputArgs, []);
  assert.equal(plan.outLabel, '[vbase]', 'the base passes straight through');
});

test('each image is its own bounded, rate-matched input', () => {
  const plan = overlayFilterLines(
    [{ overlay: ov({ start: 2, end: 5 }), input: '/tmp/a.png' }],
    '[vbase]',
    HD,
    3,
  );
  const args = plan.inputArgs.join(' ');
  // -loop without -t is an infinite stream, which is how an export hangs.
  assert.match(args, /-loop 1/);
  assert.match(args, /-t 3\.0000/, 'bounded to the overlay’s own length');
  assert.match(args, /-framerate 30\.0000/, 'or a still dissolves in 40ms steps');
  assert.match(plan.lines[0], /^\[3:v\]/, 'input index starts where the caller said');
});

test('the chain threads through every image and hands back the last label', () => {
  const plan = overlayFilterLines(
    [
      { overlay: ov({ id: 'a', start: 1, end: 3 }), input: '/tmp/a.png' },
      { overlay: ov({ id: 'b', start: 4, end: 6 }), input: '/tmp/b.png' },
    ],
    '[vbase]',
    HD,
    2,
  );
  assert.equal(plan.outLabel, '[ov1]');
  assert.ok(plan.lines.some((l) => l.startsWith('[vbase][img0]overlay=')));
  assert.ok(plan.lines.some((l) => l.startsWith('[ov0][img1]overlay=')));
  assert.equal(plan.inputArgs.filter((a) => a === '-i').length, 2);
});

test('every image is gated to its own window', () => {
  const plan = overlayFilterLines([{ overlay: ov({ start: 2, end: 5 }), input: '/a.png' }], '[v]', HD, 1);
  const line = plan.lines.find((l) => l.includes('overlay='))!;
  assert.match(line, /enable='between\(t,2\.0000,5\.0000\)'/);
  // Belt to enable's braces: without these the compositor holds the last image
  // frame over the rest of the video once its branch ends.
  assert.match(line, /eof_action=pass/);
  assert.match(line, /repeatlast=0/);
});

test('cover crops to fill; contain pads TRANSPARENT so the video shows through', () => {
  const cover = overlayFilterLines([{ overlay: ov({ fit: 'cover' }), input: '/a.png' }], '[v]', HD, 1);
  assert.match(cover.lines[0], /force_original_aspect_ratio=increase/);
  assert.match(cover.lines[0], /crop=1920:1080/);

  const contain = overlayFilterLines([{ overlay: ov({ fit: 'contain' }), input: '/a.png' }], '[v]', HD, 1);
  assert.match(contain.lines[0], /force_original_aspect_ratio=decrease/);
  // black@0, not black: there is a picture underneath and an opaque pad would
  // invent a letterbox the user never asked for.
  assert.match(contain.lines[0], /color=black@0/);
});

test('peak opacity is applied BEFORE the fades, which multiply what they are handed', () => {
  const plan = overlayFilterLines([{ overlay: ov({ opacity: 0.5 }), input: '/a.png' }], '[v]', HD, 1);
  const branch = plan.lines[0];
  const mixer = branch.indexOf('colorchannelmixer');
  const fade = branch.indexOf('fade=t=in');
  assert.ok(mixer > -1 && fade > -1);
  assert.ok(mixer < fade, 'the other order would ramp to full and then flatten to the peak');
});

test('a fully opaque image emits no opacity filter at all', () => {
  const plan = overlayFilterLines([{ overlay: ov({ opacity: 1 }), input: '/a.png' }], '[v]', HD, 1);
  assert.ok(!plan.lines[0].includes('colorchannelmixer'));
});

test('a cut emits no fade — d=0 is a degenerate ramp', () => {
  const plan = overlayFilterLines([{ overlay: ov({ transition: 'cut' }), input: '/a.png' }], '[v]', HD, 1);
  assert.ok(!plan.lines[0].includes('fade='));
});

test('a static image emits a plain number, not a per-frame expression', () => {
  const plan = overlayFilterLines(
    [{ overlay: ov({ transition: 'fade', box: { x: 0.5, y: 0.25, width: 0.5, height: 0.5 } }), input: '/a.png' }],
    '[v]',
    HD,
    1,
  );
  const line = plan.lines.find((l) => l.includes('overlay='))!;
  assert.match(line, /x='960\.0000'/);
  assert.match(line, /y='270\.0000'/);
});

test('the scaled box is even on both axes', () => {
  // An odd-sized rgba plane fed to a yuv420 compositor is a chroma-siting
  // argument nobody wins, and 2px of rounding is invisible where a failed graph
  // is not.
  const plan = overlayFilterLines(
    [{ overlay: ov({ box: { x: 0, y: 0, width: 0.3157, height: 0.3157 } }), input: '/a.png' }],
    '[v]',
    HD,
    1,
  );
  const m = /scale=(\d+):(\d+):/.exec(plan.lines[0])!;
  assert.equal(Number(m[1]) % 2, 0, m[1]);
  assert.equal(Number(m[2]) % 2, 0, m[2]);
});

// ── the parity test ───────────────────────────────────────────────────────────

test('the emitted slide expression agrees with sampleOverlay, in pixels', () => {
  const box = { x: 0.55, y: 0.1, width: 0.4, height: 0.35 };
  for (const transition of ['slide-left', 'slide-right', 'slide-up', 'slide-down'] as const) {
    const overlay = ov({ transition, box, start: 2, end: 7, ease: 0.8 });
    const plan = overlayFilterLines([{ overlay, input: '/a.png' }], '[v]', HD, 1);
    const { x, y } = parseOverlay(plan.lines.find((l) => l.includes('overlay='))!);

    for (let t = 1.5; t <= 7.5; t += 0.05) {
      const want = sampleOverlay(overlay, t);
      // Outside the region the filter is disabled, so there is nothing to agree
      // about — enable, not the expression, is what holds there.
      if (!want) continue;

      // Compared as PIXELS, not as coefficients: agreeing on the numbers while
      // disagreeing on what they index is the bug worth catching.
      const wantX = (box.x + want.dx) * HD.width;
      const wantY = (box.y + want.dy) * HD.height;
      assert.ok(
        Math.abs(evalExpr(x, { t }) - wantX) < 0.6,
        `${transition} x at ${t.toFixed(2)}: ${evalExpr(x, { t })} vs ${wantX}`,
      );
      assert.ok(
        Math.abs(evalExpr(y, { t }) - wantY) < 0.6,
        `${transition} y at ${t.toFixed(2)}: ${evalExpr(y, { t })} vs ${wantY}`,
      );
    }
  }
});

test('a slide with a hard cut has a direction — it does not latch on at its own end', () => {
  // rampExpr's degenerate branch is `gte`, and spelling the falling edge
  // backwards instead of as `1 - rise` produced a gate that switched on at the
  // region's end and stayed there. This is the frame-by-frame catch for it.
  const overlay = ov({ transition: 'slide-left', ease: 0, start: 2, end: 6 });
  const plan = overlayFilterLines([{ overlay, input: '/a.png' }], '[v]', HD, 1);
  const { x } = parseOverlay(plan.lines.find((l) => l.includes('overlay='))!);
  for (let t = 2; t < 6; t += 0.1) {
    assert.ok(Math.abs(evalExpr(x, { t }) - 0) < 0.6, `home at ${t.toFixed(1)}, got ${evalExpr(x, { t })}`);
  }
});

// ── an evaluator for the subset of ffmpeg expressions the emitter uses ────────
//
// Small on purpose. It covers exactly what posExpr can produce — + - * /,
// parentheses, unary sign, and the two functions clip and gte — so a new
// function in the emitter fails loudly here rather than being waved through.

function parseOverlay(line: string): { x: string; y: string } {
  const grab = (key: string) => {
    // x is preceded by `overlay=`, y by the `:` that ends x's quoted expression.
    const m = line.match(new RegExp(`[:=]${key}='([^']*)'`));
    assert.ok(m, `overlay has no ${key} in ${line}`);
    return m![1];
  };
  return { x: grab('x'), y: grab('y') };
}

function evalExpr(src: string, vars: Record<string, number>): number {
  let i = 0;
  const ws = () => {
    while (i < src.length && src[i] === ' ') i++;
  };

  const expr = (): number => {
    let v = term();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '+' && op !== '-') return v;
      i++;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
  };

  const term = (): number => {
    let v = factor();
    for (;;) {
      ws();
      const op = src[i];
      if (op !== '*' && op !== '/') return v;
      i++;
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
  };

  const factor = (): number => {
    ws();
    if (src[i] === '-') {
      i++;
      return -factor();
    }
    if (src[i] === '+') {
      i++;
      return factor();
    }
    return primary();
  };

  const primary = (): number => {
    ws();
    if (src[i] === '(') {
      i++;
      const v = expr();
      ws();
      assert.equal(src[i], ')', `unbalanced parens at ${i} in ${src}`);
      i++;
      return v;
    }

    const num = /^[0-9]*\.?[0-9]+/.exec(src.slice(i));
    if (num) {
      i += num[0].length;
      return Number(num[0]);
    }

    const name = /^[a-z_][a-z_0-9]*/.exec(src.slice(i));
    assert.ok(name, `unparsable at ${i} in ${src}`);
    i += name![0].length;
    ws();
    if (src[i] !== '(') {
      const v = vars[name![0]];
      assert.ok(v !== undefined, `unknown variable ${name![0]}`);
      return v;
    }

    i++; // (
    const args: number[] = [];
    for (;;) {
      args.push(expr());
      ws();
      if (src[i] === ',') {
        i++;
        continue;
      }
      assert.equal(src[i], ')', `unbalanced call at ${i} in ${src}`);
      i++;
      break;
    }

    switch (name![0]) {
      case 'clip':
        return Math.min(Math.max(args[0], args[1]), args[2]);
      case 'gte':
        return args[0] >= args[1] ? 1 : 0;
      default:
        throw new Error(`evalExpr does not implement ${name![0]}() — add it deliberately`);
    }
  };

  const value = expr();
  ws();
  assert.equal(i, src.length, `trailing input in ${src}`);
  return value;
}
