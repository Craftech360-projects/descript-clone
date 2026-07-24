import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_FRAME,
  FRAME_PRESETS,
  MAX_DIM,
  MAX_ZOOM,
  MIN_ZOOM,
  clampPan,
  fitZoom,
  containBox,
  frameFilterStages,
  frameLayout,
  frameSize,
  normalizeFrame,
  resolveFrame,
  type FrameSettings,
} from './frame.ts';

/**
 * Reframing has two implementations of one idea — an ffmpeg scale+crop for the
 * export, and a box in the monitor for the preview — and the feature is only
 * honest if they agree. So these assert each one against the arithmetic, and then
 * assert the two against EACH OTHER on the same inputs, which is the test that
 * actually catches a drift.
 */

const HD = { width: 1920, height: 1080 };

const settings = (over: Partial<FrameSettings> = {}): FrameSettings =>
  normalizeFrame({ ...DEFAULT_FRAME, ...over });

// ── the settings themselves ───────────────────────────────────────────────────

test('a fixed preset owns its size, whatever the stored numbers say', () => {
  // A project that was custom 640x480 and is switched to Reel must come out
  // 1080x1920, not 640x480 with a new label.
  const f = normalizeFrame({ preset: 'reel', width: 640, height: 480, zoom: 1, x: 0, y: 0 });
  assert.equal(f.width, FRAME_PRESETS.reel.width);
  assert.equal(f.height, FRAME_PRESETS.reel.height);
});

test('custom dimensions are forced even', () => {
  // yuv420p subsamples chroma 2x2; libx264 rejects an odd dimension outright.
  const f = normalizeFrame({ preset: 'custom', width: 1081, height: 607 });
  assert.equal(f.width % 2, 0, `${f.width}`);
  assert.equal(f.height % 2, 0, `${f.height}`);
});

test('push-ins survive the round trip through the wire', () => {
  // normalizeFrame IS the server's coercion for the whole Frame panel — the
  // /transcript PATCH and the render route both funnel through it — so a move
  // that does not survive here is a move that silently does not survive a save.
  const f = normalizeFrame({
    preset: 'reel',
    moves: [
      { id: 'b', start: 8, end: 12, zoom: 2, x: 0.4, y: -0.2, ease: 0.5, path: [{ t: 9, x: 0.1, y: 0 }] },
      { id: 'a', start: 1, end: 4, zoom: 1.5, x: 0, y: 0, ease: 0.5, path: [] },
    ],
  } as never);
  assert.deepEqual(f.moves.map((m) => m.id), ['a', 'b'], 'sorted into time order');
  assert.equal(f.moves[1].path.length, 1);
  assert.equal(f.moves[1].zoom, 2);
});

test('a project saved before push-ins existed gets an empty track, not undefined', () => {
  // Per field, not per object — the same contract every other field here keeps.
  // An undefined `moves` would throw on the first .length in the monitor.
  assert.deepEqual(normalizeFrame({ preset: 'square' }).moves, []);
  assert.deepEqual(normalizeFrame(null).moves, []);
  assert.deepEqual(DEFAULT_FRAME.moves, []);
});

test('garbage off the wire cannot reach the graph', () => {
  const f = normalizeFrame({
    preset: 'nonsense' as never,
    width: Number.NaN,
    height: -5,
    zoom: Number.POSITIVE_INFINITY,
    x: 40,
    y: -40,
  });
  assert.equal(f.preset, 'source');
  // Non-finite is not a number to clamp, it is an absent one — so it takes the
  // DEFAULT rather than the ceiling. Clamping Infinity to MAX_ZOOM would turn a
  // malformed body into a maximally zoomed render, which is a worse answer than
  // the untouched picture the field never legitimately asked to change.
  assert.equal(f.zoom, 1);
  assert.equal(f.x, 1);
  assert.equal(f.y, -1);
  // A finite number that is merely out of range does clamp.
  assert.equal(normalizeFrame({ zoom: 99 }).zoom, MAX_ZOOM);
  assert.equal(normalizeFrame({ preset: 'custom', width: 99999 }).width, MAX_DIM);
});

test('zoom goes below 1 — that is how the whole picture gets to fit', () => {
  assert.equal(normalizeFrame({ zoom: 0.25 }).zoom, 0.25);
  assert.equal(normalizeFrame({ zoom: 0.001 }).zoom, MIN_ZOOM);
});

test('fitZoom lands exactly on contain, and MIN_ZOOM is below it', () => {
  // 16:9 into 9:16 — the case in front of the user. contain/cover = 0.5625/1.7778.
  const z = fitZoom(HD, { width: 1080, height: 1920 });
  assert.ok(Math.abs(z - 0.3164) < 0.001, `${z}`);
  assert.ok(z > MIN_ZOOM, 'the slider must be able to reach fit');

  // At that zoom the whole source really is inside the frame: no travel is
  // negative, i.e. nothing overflows.
  const l = frameLayout({ zoom: z, x: 0, y: 0 }, HD, { width: 270, height: 480 });
  assert.ok(l.travelX >= -0.5, `travelX ${l.travelX}`);
  assert.ok(l.travelY >= -0.5, `travelY ${l.travelY}`);
  // And it touches one axis — it is the LARGEST fitting size, not just any.
  assert.ok(Math.abs(l.width - 270) < 0.5 || Math.abs(l.height - 480) < 0.5, `${l.width}x${l.height}`);
});

test('fit and fill coincide when the shapes already match', () => {
  assert.equal(fitZoom(HD, { width: 1920, height: 1080 }), 1);
  assert.equal(fitZoom(HD, { width: 1280, height: 720 }), 1);
});

test('clampPan holds the crop inside the overflow it indexes', () => {
  assert.deepEqual(clampPan(-3, 3), { x: -1, y: 1 });
  assert.deepEqual(clampPan(0.4, -0.2), { x: 0.4, y: -0.2 });
});

test('the source preset takes its size from the media, not the record', () => {
  assert.deepEqual(frameSize(settings(), { width: 1280, height: 720 }), { width: 1280, height: 720 });
});

// ── resolveFrame: the null that keeps an untouched project untouched ──────────

test('an untouched frame resolves to null, so no scale/crop is emitted at all', () => {
  assert.equal(resolveFrame(settings(), HD), null);
});

test('the source preset at 1x is still null even on odd source dimensions', () => {
  assert.equal(resolveFrame(settings(), { width: 1919, height: 1079 }), null);
});

test('a preset matching the source exactly is null — same pixels, no re-encode', () => {
  assert.equal(resolveFrame(settings({ preset: 'youtube' }), HD), null);
});

test('zoom alone is enough to need a crop, even at the source resolution', () => {
  const r = resolveFrame(settings({ zoom: 1.5 }), HD);
  assert.ok(r, 'zoom must resolve');
  assert.deepEqual({ width: r.width, height: r.height }, HD);
});

test('a different shape resolves, and carries the pan through', () => {
  const r = resolveFrame(settings({ preset: 'reel', x: -0.5, y: 0.25 }), HD);
  assert.deepEqual(r, { width: 1080, height: 1920, zoom: 1, x: -0.5, y: 0.25 });
});

// ── the ffmpeg stages ─────────────────────────────────────────────────────────

test('the stages are cover, pad, crop, and name no source dimension', () => {
  const s = frameFilterStages({ width: 1080, height: 1920, zoom: 1, x: 0, y: 0 });
  assert.deepEqual(s, [
    'scale=1080:1920:force_original_aspect_ratio=increase:force_divisible_by=2',
    'pad=max(iw\\,1080):max(ih\\,1920):(ow-iw)*0.5000:(oh-ih)*0.5000:color=black',
    'crop=1080:1920:(iw-ow)*0.5000:(ih-oh)*0.5000',
    'setsar=1',
  ]);
  // increase, not decrease: decrease is contain, and the cover fit is what zoom
  // is measured against.
  assert.ok(!s.join(',').includes('decrease'));
  // The commas inside max() must be escaped or the filtergraph parser ends the
  // filter mid-expression.
  assert.ok(s[1].includes('max(iw\\,'), s[1]);
});

test('pad and crop carry the same pan fraction, so it is continuous at zoom 1', () => {
  // The offset either way works out to (frame - scaled) * fx: pad places the
  // picture when it underflows, crop chooses the window when it overflows. A
  // different fraction in each would make a drag jump as it crossed zoom 1.
  const s = frameFilterStages({ width: 1080, height: 1920, zoom: 1, x: -0.4, y: 0.6 });
  const [, pfx, pfy] = s[1].match(/\(ow-iw\)\*([\d.]+):\(oh-ih\)\*([\d.]+)/)!;
  const [, cfx, cfy] = s[2].match(/\(iw-ow\)\*([\d.]+):\(ih-oh\)\*([\d.]+)/)!;
  assert.equal(pfx, cfx);
  assert.equal(pfy, cfy);
  assert.equal(pfx, '0.3000'); // (-0.4 + 1) / 2
});

test('zoom grows the scale box and leaves the crop at the frame size', () => {
  const s = frameFilterStages({ width: 1080, height: 1080, zoom: 2, x: 0, y: 0 });
  assert.ok(s[0].startsWith('scale=2160:2160:'), s[0]);
  assert.ok(s[2].startsWith('crop=1080:1080:'), s[2]);
});

test('zooming out shrinks the scale box below the frame, and the pad fills it', () => {
  const s = frameFilterStages({ width: 1080, height: 1920, zoom: 0.5, x: 0, y: 0 });
  assert.ok(s[0].startsWith('scale=540:960:'), s[0]);
  // pad grows it back to the frame; crop is then the no-op.
  assert.ok(s[1].startsWith('pad=max(iw\\,1080):max(ih\\,1920):'), s[1]);
  assert.ok(s[2].startsWith('crop=1080:1920:'), s[2]);
});

test('the scale box stays even at every zoom the UI can produce', () => {
  // Across the WHOLE range now, including below 1 where the box is small enough
  // that an off-by-one actually matters.
  for (let zoom = MIN_ZOOM; zoom <= MAX_ZOOM + 1e-9; zoom = Math.round((zoom + 0.01) * 100) / 100) {
    const [scale] = frameFilterStages({ width: 1080, height: 1920, zoom, x: 0, y: 0 });
    const [, w, h] = scale.match(/scale=(\d+):(\d+):/)!;
    assert.equal(Number(w) % 2, 0, `zoom ${zoom} -> width ${w}`);
    assert.equal(Number(h) % 2, 0, `zoom ${zoom} -> height ${h}`);
  }
});

test('pan maps -1..1 onto the whole overflow and nothing beyond it', () => {
  const at = (x: number) =>
    frameFilterStages({ width: 1080, height: 1920, zoom: 1, x, y: 0 })[2];
  assert.ok(at(-1).includes('(iw-ow)*0.0000'), at(-1)); // hard left
  assert.ok(at(0).includes('(iw-ow)*0.5000'), at(0)); // centred
  assert.ok(at(1).includes('(iw-ow)*1.0000'), at(1)); // hard right
});

// ── the preview, and its agreement with the export ────────────────────────────

// ── containBox: the frame's own size on screen ────────────────────────────────
//
// This is the regression that made the feature look broken: every preset
// previewed as the same rectangle. The CSS spelling (aspect-ratio + max-width +
// max-height) clamps the height without re-deriving the width, so the box came
// out the size of the stage at every ratio. These pin the arithmetic that
// replaced it.

test('each preset gets a DIFFERENT box in the same stage', () => {
  const stage = { width: 800, height: 450 };
  const reel = containBox({ width: 1080, height: 1920 }, stage);
  const square = containBox({ width: 1080, height: 1080 }, stage);
  const wide = containBox({ width: 1920, height: 1080 }, stage);

  // The bug: all three equal to the stage. Assert they are distinct shapes.
  const ratio = (b: { width: number; height: number }) => b.width / b.height;
  assert.ok(Math.abs(ratio(reel) - 1080 / 1920) < 1e-6, `reel ${ratio(reel)}`);
  assert.ok(Math.abs(ratio(square) - 1) < 1e-6, `square ${ratio(square)}`);
  assert.ok(Math.abs(ratio(wide) - 16 / 9) < 1e-6, `wide ${ratio(wide)}`);
  assert.ok(reel.width < square.width, 'a reel is narrower than a square');
  assert.ok(square.width < wide.width, 'a square is narrower than 16:9');
});

test('the box always fits inside the stage, and touches one axis', () => {
  const stage = { width: 800, height: 450 };
  for (const ratio of [
    { width: 1080, height: 1920 },
    { width: 1080, height: 1080 },
    { width: 1920, height: 1080 },
    { width: 800, height: 600 },
  ]) {
    const b = containBox(ratio, stage);
    assert.ok(b.width <= stage.width + 1e-6, `${b.width} > ${stage.width}`);
    assert.ok(b.height <= stage.height + 1e-6, `${b.height} > ${stage.height}`);
    // Largest such box: it must be flush against the width or the height.
    const flush =
      Math.abs(b.width - stage.width) < 1e-6 || Math.abs(b.height - stage.height) < 1e-6;
    assert.ok(flush, `${JSON.stringify(b)} is not maximal in ${JSON.stringify(stage)}`);
  }
});

test('an unmeasured stage yields a zero box rather than NaN', () => {
  assert.deepEqual(containBox({ width: 16, height: 9 }, { width: 0, height: 0 }), {
    width: 0,
    height: 0,
  });
  assert.deepEqual(containBox({ width: 0, height: 0 }, { width: 100, height: 100 }), {
    width: 0,
    height: 0,
  });
});

test('at zoom 1 the preview covers — the frame is full, the sides overflow', () => {
  // 16:9 source into a 9:16 frame: height must match exactly and width overflow.
  const l = frameLayout({ zoom: 1, x: 0, y: 0 }, HD, { width: 270, height: 480 });
  assert.equal(Math.round(l.height), 480);
  assert.ok(l.width > 480, `width ${l.width} must overflow`);
  assert.equal(Math.round(l.travelY), 0);
  assert.ok(l.travelX < 0, 'negative travel means the picture overflows');
});

test('below zoom 1 the picture insets and the travel flips sign', () => {
  const box = { width: 270, height: 480 };
  const zoomed = frameLayout({ zoom: 0.2, x: 0, y: 0 }, HD, box);
  assert.ok(zoomed.width < box.width, `${zoomed.width} must fit inside ${box.width}`);
  assert.ok(zoomed.height < box.height, `${zoomed.height} must fit inside ${box.height}`);
  assert.ok(zoomed.travelX > 0 && zoomed.travelY > 0, 'positive travel means bars');
  // Centred at pan 0: equal bars either side.
  assert.ok(Math.abs(zoomed.left - (box.width - zoomed.width) / 2) < 1e-6);
  assert.ok(Math.abs(zoomed.top - (box.height - zoomed.height) / 2) < 1e-6);
});

test('pan stays continuous as zoom crosses 1', () => {
  // The bug this guards: a drag that jumps when the picture stops overflowing.
  // Just either side of the crossing on the height axis, `top` must be tiny and
  // must not flip across a discontinuity.
  const box = { width: 480, height: 270 }; // matches HD, so the crossing is at 1
  const below = frameLayout({ zoom: 0.999, x: 0, y: 0.8 }, HD, box);
  const above = frameLayout({ zoom: 1.001, x: 0, y: 0.8 }, HD, box);
  assert.ok(Math.abs(below.top - above.top) < 1, `${below.top} vs ${above.top}`);
  assert.ok(Math.abs(below.left - above.left) < 1, `${below.left} vs ${above.left}`);
});

test('the preview and the export agree below zoom 1 too', () => {
  // The pad path, checked the same way as the crop path: where does the picture's
  // left edge sit in the finished frame, as a fraction of the frame?
  const resolved = { width: 1080, height: 1920, zoom: 0.2, x: -0.5, y: 0 };
  const box = { width: 270, height: 480 };
  const l = frameLayout(resolved, HD, box);
  const previewLeftFrac = l.left / box.width;

  const [scale, pad] = frameFilterStages(resolved);
  const [, sw, sh] = scale.match(/scale=(\d+):(\d+):/)!.map(Number) as unknown as [string, number, number];
  const [, fx] = pad.match(/\(ow-iw\)\*([\d.]+)/)!;
  const cover = Math.max(sw / HD.width, sh / HD.height);
  const realW = HD.width * cover;
  // pad places it at (frameW - scaledW) * fx; the frame is `resolved.width` wide.
  const exportLeftFrac = ((resolved.width - realW) * Number(fx)) / resolved.width;

  assert.ok(
    Math.abs(previewLeftFrac - exportLeftFrac) < 0.005,
    `${previewLeftFrac} vs ${exportLeftFrac}`,
  );
});

test('the preview and the export crop the same fraction of the picture', () => {
  // The agreement that matters: what fraction of the SOURCE survives must be the
  // same number in both, or the monitor is lying about the file.
  const frame = settings({ preset: 'reel', zoom: 1.25, x: -0.4, y: 0.2 });
  const resolved = resolveFrame(frame, HD)!;
  const box = { width: 405, height: 720 }; // a 9:16 frame as the monitor might size it

  const l = frameLayout(resolved, HD, box);
  // Preview: the visible window as a fraction of the rendered picture.
  const previewFracX = box.width / l.width;
  const previewFracY = box.height / l.height;
  const previewLeft = -l.left / l.width;

  // Export: the same quantities, from the filter strings ffmpeg will run. The pad
  // between them is a no-op here — this case is zoomed in, so nothing underflows.
  const [scale, , crop] = frameFilterStages(resolved);
  const [, sw, sh] = scale.match(/scale=(\d+):(\d+):/)!.map(Number) as unknown as [string, number, number];
  const [, cw, ch, fx] = crop.match(/crop=(\d+):(\d+):\(iw-ow\)\*([\d.]+):/)!;
  // force_original_aspect_ratio=increase covers the box, so the real scaled size
  // is the box grown on whichever axis the source is longer in.
  const cover = Math.max(sw / HD.width, sh / HD.height);
  const realW = HD.width * cover;
  const realH = HD.height * cover;

  assert.ok(Math.abs(previewFracX - Number(cw) / realW) < 0.002, `${previewFracX} vs ${Number(cw) / realW}`);
  assert.ok(Math.abs(previewFracY - Number(ch) / realH) < 0.002, `${previewFracY} vs ${Number(ch) / realH}`);
  // And they start at the same place in the picture.
  const exportLeft = (Number(fx) * (realW - Number(cw))) / realW;
  assert.ok(Math.abs(previewLeft - exportLeft) < 0.002, `${previewLeft} vs ${exportLeft}`);
});

test('the preview reports no travel when the source exactly fills the frame', () => {
  // This is what the panel and the grab cursor key off — offering a pan gesture
  // that cannot move anything is worse than offering none.
  const l = frameLayout({ zoom: 1, x: 0, y: 0 }, HD, { width: 640, height: 360 });
  assert.ok(Math.abs(l.travelX) < 0.5, `${l.travelX}`);
  assert.ok(Math.abs(l.travelY) < 0.5, `${l.travelY}`);
});

test('a degenerate box does not produce NaN geometry', () => {
  // videoWidth is 0 until metadata lands, and the frame measures 0 before layout.
  for (const [source, box] of [
    [{ width: 0, height: 0 }, { width: 100, height: 100 }],
    [HD, { width: 0, height: 0 }],
  ] as const) {
    const l = frameLayout({ zoom: 1, x: 0, y: 0 }, source, box);
    for (const v of Object.values(l)) assert.ok(Number.isFinite(v), `${v}`);
  }
});
