import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyColumns,
  clampScroll,
  clampZoom,
  KEPT,
  CUT,
  LOOKAHEAD,
  lookaheadFor,
  playStep,
  snap,
  sourceMap,
  tickStep,
  ticks,
  timecode,
  zoomAt,
} from './timeline.ts';
import type { Edl } from './types.ts';

const edl = (keep: Array<[number, number]>, sourceDuration = 100): Edl => ({
  sourceDuration,
  keep: keep.map(([start, end]) => ({ start, end })),
  fadeMs: 12,
});

test('sourceMap round-trips time through pixels', () => {
  const map = sourceMap(10, 5, 100);
  assert.equal(map.toX(5), 0, 'the left edge is scrollSec');
  assert.equal(map.toX(15), 100);
  assert.equal(map.toTime(0), 5);
  assert.equal(map.toTime(100), 15);
});

test('zoomAt keeps the time under the cursor fixed', () => {
  const view = { pxPerSec: 10, scrollSec: 5 };
  const mouseX = 200;
  const before = view.scrollSec + mouseX / view.pxPerSec;

  const zoomed = zoomAt(view, mouseX, 40);
  const after = zoomed.scrollSec + mouseX / zoomed.pxPerSec;

  assert.ok(Math.abs(before - after) < 1e-9, 'the anchored time must not move');
});

test('zoomAt anchors at the left edge and at the far right too', () => {
  for (const mouseX of [0, 1, 640, 1399]) {
    const view = { pxPerSec: 3, scrollSec: 12 };
    const before = view.scrollSec + mouseX / view.pxPerSec;
    const z = zoomAt(view, mouseX, 60);
    const after = z.scrollSec + mouseX / z.pxPerSec;
    assert.ok(Math.abs(before - after) < 1e-9, `anchor drifted at x=${mouseX}`);
  }
});

test('clampScroll keeps the viewport inside the media', () => {
  // 1000px at 10px/s shows 100s of a 120s file → max scroll is 20s.
  assert.equal(clampScroll(50, 10, 1000, 120), 20);
  assert.equal(clampScroll(-5, 10, 1000, 120), 0);
  // Zoomed out past the whole file, there is nowhere to scroll.
  assert.equal(clampScroll(5, 1, 1000, 120), 0);
});

test('clampZoom never zooms out past the whole file', () => {
  // 885s in 1400px = 1.58px/s. Nothing below that is meaningful.
  const min = clampZoom(0.001, 1400, 885);
  assert.ok(Math.abs(min - 1400 / 885) < 1e-9);
  assert.equal(clampZoom(9999, 1400, 885), 250, 'capped at MAX_PX_PER_SEC');
});

test('classifyColumns marks kept and cut regions', () => {
  // Keep 0-5 and 10-15 of a 20s file, drawn 200px wide at 10px/s.
  const map = sourceMap(10, 0, 20);
  const columns = classifyColumns(edl([[0, 5], [10, 15]], 20), map, 200);

  assert.equal(columns[0], KEPT);
  assert.equal(columns[49], KEPT, 'just inside the first keep');
  assert.equal(columns[75], CUT, 'the gap is cut');
  assert.equal(columns[120], KEPT, 'inside the second keep');
  assert.equal(columns[190], CUT, 'the tail is cut');
});

test('classifyColumns agrees with a per-column scan of the EDL', () => {
  // The naive O(width x keep) version this replaced. They must not disagree.
  const ranges = edl([[0, 5], [10, 15], [15.2, 18]], 20);
  const map = sourceMap(10, 0, 20);
  const columns = classifyColumns(ranges, map, 200);

  for (let x = 0; x < 200; x++) {
    // Sample the column's midpoint: classify rounds outward, so an edge pixel is
    // legitimately kept when any part of it is covered.
    const t = map.toTime(x + 0.5);
    const naive = ranges.keep.some((r) => t >= r.start && t < r.end) ? KEPT : CUT;
    assert.equal(columns[x], naive, `column ${x} (t=${t.toFixed(3)}) disagrees`);
  }
});

test('classifyColumns treats a null EDL as all-kept', () => {
  const columns = classifyColumns(null, sourceMap(10, 0, 20), 50);
  assert.ok(columns.every((c) => c === KEPT), 'no edit yet means nothing is cut');
});

test('classifyColumns handles scrolled and zoomed views', () => {
  // Show 10s-20s of the file; the keep at 0-5 is entirely off-screen left.
  const map = sourceMap(20, 10, 40);
  const columns = classifyColumns(edl([[0, 5], [12, 14]], 40), map, 200);

  assert.ok(columns.slice(0, 39).every((c) => c === CUT), 'off-screen keeps must not bleed in');
  assert.equal(columns[50], KEPT, '12s is 40px in');
  assert.equal(columns[100], CUT);
});

test('tickStep climbs a sexagesimal ladder, not a decimal one', () => {
  // A 1-2-5 ladder would offer 50s and never 30 or 60 — wrong for a clock.
  assert.equal(tickStep(1, 80), 120);
  assert.equal(tickStep(3, 80), 30);
  assert.equal(tickStep(10, 80), 10);
  assert.equal(tickStep(100, 80), 1);
  assert.equal(tickStep(1000, 80), 0.1);
});

test('ticks are inside the domain and marked major on the label grid', () => {
  const map = sourceMap(10, 0, 60);
  const out = ticks(map, 600, 80);

  assert.ok(out.length > 0);
  assert.ok(out.every((t) => t.time >= 0 && t.time <= 60), 'never outside the media');
  assert.ok(out.some((t) => t.major), 'some ticks must be labelled');

  const majors = out.filter((t) => t.major).map((t) => t.time);
  const step = tickStep(10, 80);
  for (const time of majors) {
    assert.ok(Math.abs(Math.round(time / step) * step - time) < 1e-6, `${time} is not on the major grid`);
  }
});

test('ticks do not drift over a long ruler', () => {
  // Stepping by += on floats accumulates error; this walks an integer grid.
  const map = sourceMap(2, 0, 3600);
  const out = ticks(map, 1400, 80);
  for (const tick of out) {
    assert.ok(Math.abs(tick.time - Math.round(tick.time)) < 1e-6, `drifted: ${tick.time}`);
  }
});

test('timecode formats honestly', () => {
  assert.equal(timecode(0), '0:00');
  assert.equal(timecode(65), '1:05');
  assert.equal(timecode(3661, { hours: true }), '1:01:01');
  assert.equal(timecode(3661), '1:01:01', 'hours appear when they exist');
  assert.equal(timecode(12.345, { ms: true }), '0:12.345');
  assert.equal(timecode(-5), '-0:05');
});

test('timecode does not lose a millisecond to float error', () => {
  // The real sample is 885.184s. 885.184 % 1 is 0.18399999…, so a float floor
  // renders this as 14:45.183.
  assert.equal(timecode(885.184, { ms: true }), '14:45.184');
  assert.equal(timecode(0.07, { ms: true }), '0:00.070');
});

test('timecode carries correctly at the minute boundary', () => {
  // Rounding ms independently of seconds would print "0:59.1000".
  assert.equal(timecode(59.9995, { ms: true }), '1:00.000');
  assert.equal(timecode(59.999, { ms: true }), '0:59.999');
  assert.equal(timecode(3599.9999, { ms: true, hours: true }), '1:00:00.000');
});

test('playStep continues while there is kept audio left', () => {
  const e = edl([[0, 5], [10, 15]], 20);
  assert.deepEqual(playStep(e, 0), { action: 'continue' });
  assert.deepEqual(playStep(e, 4.9), { action: 'continue' }, '0.1s left is more than the lookahead');
});

test('playStep jumps BEFORE the cut, not after it', () => {
  const e = edl([[0, 5], [10, 15]], 20);
  // The whole bug in one assertion: at 4.98 the old code was still playing,
  // and would not notice until timeupdate fired somewhere past 5.0 — inside
  // material the user deleted.
  assert.deepEqual(playStep(e, 4.98), { action: 'seek', to: 10, silent: true });
});

test('playStep never lets the playhead sit inside a cut', () => {
  // Walk the whole file at 60Hz and assert we are told to leave every removed
  // region before entering it.
  const e = edl([[0, 5], [10, 15]], 20);
  const cut = (t: number) => !e.keep.some((r) => t >= r.start && t < r.end);

  let t = 0;
  let bled = 0;
  for (let frame = 0; frame < 60 * 20; frame++) {
    const step = playStep(e, t);
    if (step.action === 'stop') break;
    if (step.action === 'seek') { t = step.to; continue; }
    t += 1 / 60;
    if (cut(t)) bled++;
  }
  assert.equal(bled, 0, 'the playhead entered cut material');
});

test('the OLD reactive rule bleeds, which is what LOOKAHEAD fixes', () => {
  // Same walk, but polling at timeupdate's ~4Hz and only reacting once already
  // inside a cut — the behaviour this replaced. It should bleed, or the test
  // above is not proving anything.
  const e = edl([[0, 5], [10, 15]], 20);
  const cut = (t: number) => !e.keep.some((r) => t >= r.start && t < r.end);

  let t = 0;
  let bled = 0;
  for (let tick = 0; tick < 4 * 20; tick++) {
    if (cut(t)) {
      const next = e.keep.find((r) => r.start > t);
      if (!next) break;
      bled++;      // we only noticed after arriving
      t = next.start;
      continue;
    }
    t += 0.25;     // timeupdate granularity
  }
  assert.ok(bled > 0, 'the old rule should demonstrably enter cut material');
});

test('playStep escapes a cut if the playhead is dropped into one', () => {
  const e = edl([[0, 5], [10, 15]], 20);
  assert.deepEqual(playStep(e, 7), { action: 'seek', to: 10, silent: true }, 'seeked into a cut');
});

test('playStep stops at the end of the edit rather than playing the cut tail', () => {
  const e = edl([[0, 5], [10, 15]], 20);
  assert.deepEqual(playStep(e, 14.99), { action: 'stop' }, 'no range follows');
  assert.deepEqual(playStep(e, 18), { action: 'stop' }, 'past the last kept range');
  assert.deepEqual(playStep(edl([], 20), 0), { action: 'stop' }, 'everything is cut');
});

test('playStep does not mute across a boundary whose sides touch', () => {
  // Two ranges that meet exactly: a splice with no gap. Gating the audio here
  // would introduce the artifact it exists to prevent.
  const e = edl([[0, 5], [5, 10]], 12);
  assert.deepEqual(playStep(e, 4.98), { action: 'seek', to: 5, silent: false });
});

test('snap uses a pixel radius, so the magnet feels equal at every zoom', () => {
  const targets = [10, 20];

  // At 10px/s, 10.5s is 5px from 10s → inside an 8px radius.
  assert.equal(snap(10.5, targets, sourceMap(10, 0, 100), 8), 10);

  // At 100px/s the same 0.5s is 50px away → out of range, no snap.
  assert.equal(snap(10.5, targets, sourceMap(100, 0, 100), 8), 10.5);
});

test('snap picks the nearest target', () => {
  const map = sourceMap(10, 0, 100);
  assert.equal(snap(10.2, [10, 10.5], map, 8), 10.2 - 0.2, 'nearest wins');
  assert.equal(snap(99, [10, 20], map, 8), 99, 'nothing in range leaves the time alone');
});

// ── lookahead vs. playback rate ───────────────────────────────────────────────

test('the lookahead outruns the playhead at every supported speed', () => {
  // The invariant: the loop is asked once per animation frame, so it must look
  // further ahead than the playhead can travel between two of them. Fail this
  // and playStep sails past the boundary and leaks cut audio for a frame.
  const FRAME = 1 / 60;
  for (const rate of [0.5, 1, 1.2, 1.5, 2]) {
    const travelPerFrame = FRAME * rate;
    assert.ok(
      lookaheadFor(rate) > travelPerFrame,
      `${rate}x travels ${(travelPerFrame * 1000).toFixed(1)}ms/frame but looks ` +
        `${(lookaheadFor(rate) * 1000).toFixed(1)}ms ahead`,
    );
  }
});

test('a fixed lookahead would NOT survive 2x — this is why it scales', () => {
  // The regression this guards: LOOKAHEAD is 30ms, and at 2x the playhead moves
  // 33ms per frame. Hard-coding the constant would be one frame too slow.
  assert.ok(LOOKAHEAD < (1 / 60) * 2, 'the unscaled constant is genuinely too small at 2x');
  assert.equal(lookaheadFor(1), LOOKAHEAD, '1x is unchanged from before speed existed');
});

test('playStep jumps earlier at speed, and at the same place', () => {
  const edl: Edl = { sourceDuration: 10, keep: [{ start: 0, end: 5 }, { start: 8, end: 10 }], fadeMs: 12 };

  // 4.95 is inside the 2x lookahead (60ms) but outside the 1x one (30ms).
  assert.deepEqual(playStep(edl, 4.95, lookaheadFor(1)), { action: 'continue' });
  assert.deepEqual(playStep(edl, 4.95, lookaheadFor(2)), { action: 'seek', to: 8, silent: true });
});
