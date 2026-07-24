import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_EASE_SEC,
  MAX_PUNCH_ZOOM,
  MIN_MOVE_SEC,
  addMove,
  boxToPunch,
  createMove,
  evalHinges,
  hingeBasis,
  isRestingTrack,
  moveAt,
  moveStrength,
  movesToOutput,
  normalizeMoves,
  punchFilterStage,
  punchLayout,
  punchToBox,
  samplePath,
  samplePunch,
  smoothstep,
  type FrameMove,
} from './frame-track.ts';
import { frameLayout } from './frame.ts';

/**
 * A punch-in has TWO implementations of one function — samplePunch, which the
 * monitor draws with, and a zoompan expression, which ffmpeg renders with. If
 * they drift the app shows a crop it does not ship, and no amount of testing
 * either one alone would notice.
 *
 * So the centrepiece here is an evaluator for the subset of ffmpeg's expression
 * language the emitter uses (evalExpr, below). The emitted string is parsed and
 * run against the same instants samplePunch is asked about, and the two are
 * compared as PIXELS — not as coefficients, because agreeing on the numbers
 * while disagreeing on what they mean is exactly the bug worth catching.
 */

const HD = { width: 1920, height: 1080 };
const REEL = { width: 1080, height: 1920 };

const move = (over: Partial<FrameMove> = {}): FrameMove => ({
  id: 'm1',
  start: 2,
  end: 8,
  ease: 1,
  zoom: 2,
  x: 0,
  y: 0,
  path: [],
  ...over,
});

// ── the ramp ──────────────────────────────────────────────────────────────────

test('a move is inert outside its own region', () => {
  const m = move();
  assert.equal(moveStrength(m, 0), 0);
  assert.equal(moveStrength(m, 1.99), 0);
  assert.equal(moveStrength(m, 8.01), 0);
  assert.equal(moveStrength(m, 100), 0);
});

test('the ramp starts and ends at rest, which is the point of the S', () => {
  const m = move();
  // Zero derivative at both ends: the first and last tenth of the ease move the
  // picture far less than the middle does. A linear ramp would move it the same
  // amount everywhere, which is what reads as the camera being shoved.
  const eps = 0.05;
  const atStart = moveStrength(m, 2 + eps) - moveStrength(m, 2);
  const atMiddle = moveStrength(m, 2.5 + eps) - moveStrength(m, 2.5);
  assert.ok(atMiddle > atStart * 4, `${atMiddle} vs ${atStart}`);
  assert.ok(Math.abs(moveStrength(m, 3) - 1) < 1e-9);
});

test('a zero ease is a hard cut, not a division by zero', () => {
  const m = move({ ease: 0 });
  assert.equal(moveStrength(m, 1.999), 0);
  assert.equal(moveStrength(m, 2), 1);
  assert.equal(moveStrength(m, 5), 1);
  assert.equal(moveStrength(m, 8), 0);
});

test('an ease longer than the region collapses to a triangle', () => {
  // 4s of ease each end on a 2s move cannot both happen; it is clamped to half,
  // so the move reaches full strength exactly once, in the middle.
  const m = move({ start: 0, end: 2, ease: 4 });
  assert.ok(Math.abs(moveStrength(m, 1) - 1) < 1e-9);
  assert.ok(moveStrength(m, 0.5) < 1);
  assert.ok(moveStrength(m, 1.5) < 1);
});

test('smoothstep is flat outside its span', () => {
  assert.equal(smoothstep(1, 2, 0), 0);
  assert.equal(smoothstep(1, 2, 3), 1);
  assert.equal(smoothstep(1, 1, 1), 1);
  assert.ok(Math.abs(smoothstep(0, 1, 0.5) - 0.5) < 1e-12);
});

// ── sampling ──────────────────────────────────────────────────────────────────

test('the resting frame is exactly untouched', () => {
  const p = samplePunch([move()], 0);
  assert.deepEqual(p, { zoom: 1, x: 0, y: 0 });
});

test('zoom and pan ramp TOGETHER, so the picture never swings while it grows', () => {
  const m = move({ x: 1, y: -1 });
  const half = samplePunch([m], 2.5);
  const full = samplePunch([m], 5);
  // At the instant the zoom is half way in, the pan is half way across. Ramping
  // only the zoom would slide the picture sideways at full speed from frame one.
  const s = moveStrength(m, 2.5);
  assert.ok(Math.abs(half.zoom - (1 + s)) < 1e-9);
  assert.ok(Math.abs(half.x - s) < 1e-9);
  assert.deepEqual(full, { zoom: 2, x: 1, y: -1 });
});

test('a tracked path holds at both ends rather than extrapolating', () => {
  // A tracker with no opinion about the edges must not invent one: continuing
  // the last two samples' slope is how a follow slides off the subject.
  const m = move({ path: [{ t: 4, x: 0, y: 0 }, { t: 5, x: 0.5, y: 0 }] });
  assert.equal(samplePath(m, 2).x, 0);
  assert.equal(samplePath(m, 4).x, 0);
  assert.equal(samplePath(m, 4.5).x, 0.25);
  assert.equal(samplePath(m, 5).x, 0.5);
  assert.equal(samplePath(m, 8).x, 0.5);
});

test('a path overrides the held framing, and clearing it gives that framing back', () => {
  const held = move({ x: -0.8 });
  const tracked = { ...held, path: [{ t: 3, x: 0.4, y: 0 }] };
  assert.equal(samplePath(tracked, 5).x, 0.4);
  assert.equal(samplePath(held, 5).x, -0.8);
});

test('two moves never both apply', () => {
  const a = move({ id: 'a', start: 0, end: 4, ease: 0 });
  const b = move({ id: 'b', start: 4, end: 8, ease: 0 });
  // The seam is the one instant both could claim; the half-open region means
  // exactly one does, so the zooms cannot sum to 3.
  assert.equal(samplePunch([a, b], 4).zoom, 2);
});

test('an empty track is resting', () => {
  assert.ok(isRestingTrack([]));
  assert.ok(isRestingTrack([move({ zoom: 1 })]));
  assert.ok(!isRestingTrack([move()]));
});

// ── coercion ──────────────────────────────────────────────────────────────────

test('garbage off the wire cannot reach the graph', () => {
  const moves = normalizeMoves([
    null,
    'nonsense',
    { start: 'x', end: 'y' },
    { start: 1, end: 9, zoom: 99, x: 40, y: -40, ease: -3 },
  ]);
  assert.equal(moves.length, 1);
  assert.equal(moves[0].zoom, MAX_PUNCH_ZOOM);
  assert.equal(moves[0].x, 1);
  assert.equal(moves[0].y, -1);
  assert.equal(moves[0].ease, 0);
});

test('a non-finite value is an ABSENT one, not a value to clamp', () => {
  // The same contract normalizeFrame keeps: Infinity is not "as far in as
  // possible", it is a field that did not survive JSON. Clamping it to the
  // maximum would turn a broken record into a 4x push-in nobody asked for.
  const [m] = normalizeMoves([{ start: 1, end: 9, zoom: Number.POSITIVE_INFINITY }]);
  assert.equal(m.zoom, 1);
});

test('overlapping moves are dropped, not blended', () => {
  // There is no sensible average of "push in on her" and "push in on him", and
  // summing them lands on a framing neither asked for.
  const moves = normalizeMoves([
    { id: 'a', start: 0, end: 5, zoom: 2 },
    { id: 'b', start: 3, end: 9, zoom: 3 },
    { id: 'c', start: 6, end: 9, zoom: 3 },
  ]);
  assert.deepEqual(moves.map((m) => m.id), ['a', 'c']);
});

test('moves come back in time order however they were sent', () => {
  const moves = normalizeMoves([
    { id: 'late', start: 10, end: 14 },
    { id: 'early', start: 1, end: 4 },
  ]);
  assert.deepEqual(moves.map((m) => m.id), ['early', 'late']);
});

test('a move too short to hold an ease is refused outright', () => {
  assert.equal(normalizeMoves([{ start: 1, end: 1 + MIN_MOVE_SEC / 2 }]).length, 0);
});

test('the marked rectangle is kept beside the shot it resolved to', () => {
  // They are different rectangles — boxToPunch widens a tall mark to the frame's
  // aspect — and the tracker wants the one that was actually drawn.
  const [m] = normalizeMoves([
    { start: 1, end: 5, zoom: 2, mark: { x: 0.4, y: 0.1, width: 0.2, height: 0.5 } },
  ]);
  assert.deepEqual(m.mark, { x: 0.4, y: 0.1, width: 0.2, height: 0.5 });
});

test('a mark dragged off the edge is clamped into the picture', () => {
  // The pointer can leave the frame; a template cut partly out of pixels that do
  // not exist is not a template.
  const [m] = normalizeMoves([
    { start: 1, end: 5, zoom: 2, mark: { x: 0.8, y: 0.9, width: 0.5, height: 0.4 } },
  ]);
  assert.ok(m.mark!.x + m.mark!.width <= 1 + 1e-9);
  assert.ok(m.mark!.y + m.mark!.height <= 1 + 1e-9);
});

test('a move with no mark carries no key for one', () => {
  // Not `mark: undefined`: isEmptyPatch compares moves by value, and a phantom
  // key would report a change on every save of an untouched move.
  const [m] = normalizeMoves([{ start: 1, end: 5, zoom: 2 }]);
  assert.ok(!('mark' in m), Object.keys(m).join(','));
  assert.equal(normalizeMoves([{ start: 1, end: 5, mark: { x: 0, y: 0, width: 0, height: 0.4 } }])[0].mark, undefined);
});

test('tracked samples outside their move are dropped', () => {
  const [m] = normalizeMoves([
    { start: 2, end: 6, path: [{ t: 0, x: 1, y: 0 }, { t: 4, x: 0.2, y: 0 }, { t: 9, x: -1, y: 0 }] },
  ]);
  assert.deepEqual(m.path.map((p) => p.t), [4]);
});

// ── editing ───────────────────────────────────────────────────────────────────

test('a new move is a visible push-in, not a no-op waiting to be configured', () => {
  const m = createMove(3, 9, 'x');
  assert.ok(m.zoom > 1);
  assert.equal(m.ease, DEFAULT_EASE_SEC);
});

test('adding an overlapping move returns the ORIGINAL array', () => {
  // Referential equality, so the caller's no-op test — and therefore the undo
  // stack — needs no special case for a refused add.
  const moves = [move()];
  assert.equal(addMove(moves, createMove(4, 6, 'x')), moves);
  assert.equal(addMove(moves, createMove(9, 12, 'x')).length, 2);
});

test('moveAt finds the move the monitor is editing', () => {
  const moves = [move({ id: 'a', start: 1, end: 3 }), move({ id: 'b', start: 5, end: 7 })];
  assert.equal(moveAt(moves, 2)?.id, 'a');
  assert.equal(moveAt(moves, 4), null);
  assert.equal(moveAt(moves, 5)?.id, 'b');
});

// ── the marked box ────────────────────────────────────────────────────────────

test('marking a box keeps ALL of it, and takes more of the other axis', () => {
  // A box of a different shape from the frame cannot be delivered by a crop that
  // preserves the frame's aspect. Containing it is the only direction that
  // cannot lose something the user pointed at.
  const p = boxToPunch({ x: 0.25, y: 0.4, width: 0.5, height: 0.2 });
  assert.equal(p.zoom, 2);
  const box = punchToBox(p);
  assert.ok(box.x <= 0.25 + 1e-9 && box.x + box.width >= 0.75 - 1e-9);
  assert.ok(box.y <= 0.4 + 1e-9 && box.y + box.height >= 0.6 - 1e-9);
});

test('a marked box round-trips through the punch when its shape already matches', () => {
  const marked = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  const box = punchToBox(boxToPunch(marked));
  assert.ok(Math.abs(box.x - marked.x) < 1e-9, `${box.x}`);
  assert.ok(Math.abs(box.width - marked.width) < 1e-9);
});

test('a box marked against an edge stays inside the picture', () => {
  const p = boxToPunch({ x: 0, y: 0, width: 0.25, height: 0.25 });
  assert.equal(p.x, -1);
  assert.equal(p.y, -1);
  const box = punchToBox(p);
  assert.equal(box.x, 0);
  assert.equal(box.y, 0);
});

test('marking the whole frame is not a push-in', () => {
  assert.equal(boxToPunch({ x: 0, y: 0, width: 1, height: 1 }).zoom, 1);
});

// ── the preview ───────────────────────────────────────────────────────────────

test('the punched preview keeps the marked window on screen', () => {
  const box = { width: 480, height: 270 };
  const base = frameLayout({ zoom: 1, x: 0, y: 0 }, HD, box);
  const punched = punchLayout(base, { zoom: 2, x: -1, y: -1 }, box);
  // Panned hard to the top-left, the picture's own top-left is at the frame's.
  assert.ok(Math.abs(punched.left) < 1e-9);
  assert.ok(Math.abs(punched.top) < 1e-9);
  assert.equal(punched.width, base.width * 2);
});

test('a resting punch leaves the layout alone', () => {
  const box = { width: 480, height: 270 };
  const base = frameLayout({ zoom: 1.5, x: 0.3, y: 0 }, HD, box);
  assert.deepEqual(punchLayout(base, { zoom: 1, x: 0, y: 0 }, box), base);
});

// ── moving onto the output clock ──────────────────────────────────────────────

const identity = (t: number) => t;

test('a move survives having its ends cut', () => {
  // Trimming the first second off a push-in shortens it; it does not delete it.
  const map = (t: number) => (t < 3 ? null : t - 3);
  const [m] = movesToOutput([move({ start: 2, end: 8 })], map, (from, to) => (to > from ? 0 : null));
  assert.equal(m.start, 0);
  assert.equal(m.end, 5);
});

test('a move whose content is entirely gone is dropped', () => {
  assert.equal(movesToOutput([move()], () => null).length, 0);
});

test('the ease shrinks with the region it rides on', () => {
  // A 1s ramp on a region the edit shortened to 0.8s would BE the whole move.
  const [m] = movesToOutput([move({ start: 0, end: 6, ease: 1 })], (t) => t / 10);
  assert.ok(m.ease <= (m.end - m.start) / 2);
});

test('tracked samples inside a cut simply vanish, and the path spans the hole', () => {
  const map = (t: number) => (t > 4 && t < 6 ? null : t);
  const [m] = movesToOutput(
    [move({ start: 2, end: 8, path: [{ t: 3, x: 0, y: 0 }, { t: 5, x: 1, y: 0 }, { t: 7, x: -1, y: 0 }] })],
    map,
  );
  assert.deepEqual(m.path.map((p) => p.t), [3, 7]);
});

// ── the render, against the preview ───────────────────────────────────────────

test('no moves means no filter at all', () => {
  assert.equal(punchFilterStage([], REEL, 30), null);
  assert.equal(punchFilterStage([move({ zoom: 1 })], REEL, 30), null);
});

test('an unknown frame rate is refused rather than guessed', () => {
  // zoompan generates its own timestamps from fps, so a wrong one is a
  // wrong-LENGTH video. Emitting nothing loses the move; emitting a guess loses
  // the export.
  assert.equal(punchFilterStage([move()], REEL, 0), null);
});

test('the stage asks for the frame it was given back', () => {
  const stage = punchFilterStage([move()], REEL, 30)!;
  assert.match(stage, /:s=1080x1920:/);
  assert.match(stage, /:d=1:/);
  assert.match(stage, /fps=30\.0000$/);
});

test('the emitted expression and samplePunch agree, frame by frame', () => {
  const moves = [
    move({ id: 'a', start: 1, end: 5, ease: 0.75, zoom: 2.5, x: 0.6, y: -0.4 }),
    move({
      id: 'b',
      start: 7,
      end: 12,
      ease: 0,
      zoom: 1.8,
      path: [
        { t: 7.5, x: -0.9, y: 0.2 },
        { t: 9, x: 0.1, y: 0.5 },
        { t: 11, x: 0.8, y: -0.3 },
      ],
    }),
  ];
  const stage = punchFilterStage(moves, REEL, 30)!;
  const { z, x, y } = parseZoompan(stage);

  for (let t = 0; t <= 14; t += 1 / 30) {
    const want = samplePunch(moves, t);
    // zoompan's input here IS the delivered frame — the punch rides on top of a
    // finished W×H picture — so iw/ih and ow/oh are both the output size.
    const vars = { in_time: t, iw: REEL.width, ih: REEL.height, ow: REEL.width, oh: REEL.height };
    const gotZ = evalExpr(z, vars);
    assert.ok(Math.abs(gotZ - want.zoom) < 2e-4, `zoom at ${t.toFixed(3)}: ${gotZ} vs ${want.zoom}`);

    // Compared as PIXELS, not as coefficients: agreeing on the numbers while
    // disagreeing on what they index is the bug worth catching.
    const withZoom = { ...vars, zoom: gotZ };
    const wantX = (REEL.width * want.zoom - REEL.width) * ((want.x + 1) / 2);
    const wantY = (REEL.height * want.zoom - REEL.height) * ((want.y + 1) / 2);
    assert.ok(Math.abs(evalExpr(x, withZoom) - wantX) < 0.5, `x at ${t.toFixed(3)}`);
    assert.ok(Math.abs(evalExpr(y, withZoom) - wantY) < 0.5, `y at ${t.toFixed(3)}`);
  }
});

test('the punch never asks zoompan for a zoom it refuses', () => {
  // zoompan clamps zoom below 1 silently, which would be a punch that quietly
  // stopped tracking rather than an error anyone would see.
  const moves = [move({ start: 0, end: 4, zoom: MAX_PUNCH_ZOOM })];
  const { z } = parseZoompan(punchFilterStage(moves, REEL, 30)!);
  for (let t = -1; t <= 5; t += 0.05) {
    const v = evalExpr(z, { in_time: t });
    assert.ok(v >= 1 - 1e-9 && v <= MAX_PUNCH_ZOOM + 1e-9, `${v} at ${t}`);
  }
});

test('every emitted expression is single-quoted, so its commas survive the parser', () => {
  // The filtergraph splits arguments on commas BEFORE any filter sees them.
  // frameFilterStages escapes them because its max() sits unquoted; here quoting
  // does the same job, and getting it wrong is a graph that will not parse.
  const stage = punchFilterStage([move({ path: [{ t: 3, x: 1, y: 0 }, { t: 4, x: 0, y: 0 }] })], REEL, 30)!;
  for (const [, body] of stage.matchAll(/[zxy]='([^']*)'/g)) {
    assert.ok(!body.includes("'"), 'an expression may not contain a bare quote');
  }
  // Outside the quotes there must be no comma at all, or the stage would split.
  assert.equal(stage.replace(/'[^']*'/g, ''), stage.replace(/'[^']*'/g, '').replace(/,/g, ''));
});

// ── the hinge basis both spellings are built from ─────────────────────────────

test('hinge form is the same line as the search-and-interpolate form', () => {
  const points = [
    { t: 0, v: -1 },
    { t: 1, v: 0.5 },
    { t: 3, v: 0.5 },
    { t: 4, v: -0.25 },
  ];
  const basis = hingeBasis(points);
  const m = move({ start: 0, end: 4, path: points.map((p) => ({ t: p.t, x: p.v, y: 0 })) });
  for (let t = 0; t <= 4; t += 0.05) {
    assert.ok(Math.abs(evalHinges(basis, t) - samplePath(m, t).x) < 1e-9, `${t}`);
  }
});

test('a single point is a constant', () => {
  assert.deepEqual(hingeBasis([{ t: 5, v: 0.3 }]), { v0: 0.3, hinges: [] });
});

// ── an evaluator for the subset of ffmpeg expressions the emitter uses ────────
//
// Small on purpose. It covers exactly what punchFilterStage can produce —
// + - * /, parentheses, unary sign, and the four functions clip, max, gte, lt —
// so a new function in the emitter fails loudly here rather than being waved
// through untested.

function parseZoompan(stage: string): { z: string; x: string; y: string } {
  const grab = (key: string) => {
    const m = stage.match(new RegExp(`${key}='([^']*)'`));
    assert.ok(m, `zoompan has no ${key}`);
    return m![1];
  };
  return { z: grab('z'), x: grab('x'), y: grab('y') };
}

function evalExpr(src: string, vars: Record<string, number>): number {
  let i = 0;
  const ws = () => { while (i < src.length && src[i] === ' ') i++; };

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
    if (src[i] === '-') { i++; return -factor(); }
    if (src[i] === '+') { i++; return factor(); }
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
    if (num) { i += num[0].length; return Number(num[0]); }

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
      if (src[i] === ',') { i++; continue; }
      assert.equal(src[i], ')', `unbalanced call at ${i} in ${src}`);
      i++;
      break;
    }

    switch (name![0]) {
      case 'clip': return Math.min(args[2], Math.max(args[1], args[0]));
      case 'max': return Math.max(args[0], args[1]);
      case 'min': return Math.min(args[0], args[1]);
      case 'gte': return args[0] >= args[1] ? 1 : 0;
      case 'lt': return args[0] < args[1] ? 1 : 0;
      default: throw new Error(`the emitter used ${name![0]}, which this evaluator does not know`);
    }
  };

  const value = expr();
  ws();
  assert.equal(i, src.length, `trailing garbage in ${src}`);
  return value;
}
