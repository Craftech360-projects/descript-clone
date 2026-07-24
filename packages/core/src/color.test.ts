import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLOR_PRESETS,
  DEFAULT_COLOR,
  colorFilterStages,
  colorLabel,
  colorSummary,
  colorSvgFilter,
  normalizeColor,
  presetSettings,
  resolveColor,
  type ColorPreset,
  type ColorSettings,
  type Grade,
} from './color.ts';

/**
 * A grade has two implementations of one idea — an ffmpeg filter chain for the
 * export, and an SVG filter for the monitor — and the feature is only honest if
 * they agree. So these assert each one against the arithmetic, and then assert
 * the two against EACH OTHER on the same inputs, which is the test that actually
 * catches a drift.
 *
 * Same shape as frame.test.ts, for the same reason.
 */

const settings = (over: Partial<ColorSettings> = {}): ColorSettings =>
  normalizeColor({ ...DEFAULT_COLOR, preset: 'custom', ...over });

/** Every knob at an interesting value, for the cross-checks below. */
const TABLE: ColorSettings[] = [
  settings({ exposure: 0.4 }),
  settings({ exposure: -0.6 }),
  settings({ temperature: 0.8 }),
  settings({ temperature: -0.8, tint: 0.5 }),
  settings({ saturation: 0 }),
  settings({ saturation: 1.7 }),
  settings({ contrast: 0.5 }),
  settings({ contrast: -0.5 }),
  settings({ shadows: 0.7 }),
  settings({ shadows: -0.7 }),
  settings({ exposure: 0.2, temperature: 0.3, tint: -0.2, saturation: 1.2, contrast: 0.3, shadows: 0.2 }),
  ...(Object.keys(COLOR_PRESETS) as Array<keyof typeof COLOR_PRESETS>).map((k) => presetSettings(k)),
];

// ── the settings themselves ───────────────────────────────────────────────────

test('a neutral grade resolves to nothing at all', () => {
  // The whole no-op guarantee rests on this: null is what keeps a project that
  // never opens the panel byte-identical to one from before grading existed.
  assert.equal(resolveColor(DEFAULT_COLOR), null);
  assert.equal(resolveColor(normalizeColor({ preset: 'none' })), null);
  assert.deepEqual(colorFilterStages({ matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1], slope: 1, intercept: 0 }), []);
});

test('every preset resolves to something, and round-trips unchanged', () => {
  for (const key of Object.keys(COLOR_PRESETS) as Array<keyof typeof COLOR_PRESETS>) {
    const s = presetSettings(key);
    assert.deepEqual(normalizeColor(s), s, key);
    assert.ok(resolveColor(s), `${key} must actually change the picture`);
  }
});

test('coercion is per field, not per object', () => {
  // A project saved before a knob existed keeps the knobs it has.
  const c = normalizeColor({ preset: 'custom', contrast: 0.4 });
  assert.equal(c.contrast, 0.4);
  assert.equal(c.saturation, 1);
  assert.equal(c.exposure, 0);
});

test('anything unusable off the wire lands on neutral', () => {
  const bad = normalizeColor({
    preset: 'sepia-tone' as ColorPreset,
    contrast: NaN,
    saturation: 'warm' as unknown as number,
    exposure: Infinity,
  });
  assert.deepEqual(bad, DEFAULT_COLOR);
});

test('out-of-range knobs are clamped, not rejected', () => {
  const c = normalizeColor({ preset: 'custom', exposure: 9, saturation: -3, tint: -40 });
  assert.equal(c.exposure, 1);
  assert.equal(c.saturation, 0);
  assert.equal(c.tint, -1);
});

test("'none' is neutral by definition, whatever numbers are stored beside it", () => {
  // The same rule that makes a fixed frame preset own its size: switching back to
  // None must actually be none, not none-with-the-last-custom-contrast.
  const c = normalizeColor({ preset: 'none', contrast: 0.9, saturation: 0 });
  assert.deepEqual(c, DEFAULT_COLOR);
});

// ── the matrix ────────────────────────────────────────────────────────────────

test('saturation 0 is a real greyscale on the luma coefficients', () => {
  const g = resolveColor(settings({ saturation: 0 }))!;
  const [r0, g0, b0, r1, g1, b1, r2, g2, b2] = g.matrix;
  // Every row identical means every channel comes out the same value — which is
  // what grey is. Rec.709, and the same coefficients the SVG matrix carries.
  assert.deepEqual([r0, g0, b0].map(round4), [0.2126, 0.7152, 0.0722]);
  assert.deepEqual([r1, g1, b1].map(round4), [0.2126, 0.7152, 0.0722]);
  assert.deepEqual([r2, g2, b2].map(round4), [0.2126, 0.7152, 0.0722]);
  // …and the rows sum to 1, so mid grey stays exactly mid grey.
  assert.equal(round4(r0 + g0 + b0), 1);
});

test('exposure is stops: +1 doubles, -1 halves', () => {
  assert.equal(round4(resolveColor(settings({ exposure: 1 }))!.matrix[0]), 2);
  assert.equal(round4(resolveColor(settings({ exposure: -1 }))!.matrix[0]), 0.5);
});

test('temperature opposes red and blue and leaves green alone', () => {
  const warm = resolveColor(settings({ temperature: 1 }))!;
  assert.ok(warm.matrix[0] > 1, 'red gains');
  assert.ok(warm.matrix[8] < 1, 'blue loses');
  assert.equal(round4(warm.matrix[4]), 1, 'green untouched');
  // Symmetric: cooling by the same amount is the mirror of warming.
  const cool = resolveColor(settings({ temperature: -1 }))!;
  assert.equal(round4(warm.matrix[0]), round4(cool.matrix[8]));
});

test('saturation is applied outermost, so it takes the white balance with it', () => {
  // Desaturating a warm grade must remove the warmth. If saturation ran first the
  // balance would be applied to an already-grey picture and Mono would come out
  // tinted — which is the bug this ordering exists to prevent.
  const g = resolveColor(settings({ temperature: 0.8, saturation: 0 }))!;
  const rowR = g.matrix.slice(0, 3).reduce(sum, 0);
  const rowG = g.matrix.slice(3, 6).reduce(sum, 0);
  const rowB = g.matrix.slice(6, 9).reduce(sum, 0);
  assert.equal(round4(rowR), round4(rowG));
  assert.equal(round4(rowG), round4(rowB));
});

// ── the affine ────────────────────────────────────────────────────────────────

test('contrast pivots on mid grey', () => {
  const g = resolveColor(settings({ contrast: 1 }))!;
  assert.equal(round4(g.slope), 2);
  assert.equal(round4(affine(0.5, g)), 0.5, 'mid grey does not move');
  assert.equal(round4(affine(0.75, g)), 1);
});

test('shadows anchor white at both ends of the knob', () => {
  // A lift that clipped the highlights would be a bug you only see on faces.
  for (const shadows of [1, 0.5, -0.5, -1]) {
    const g = resolveColor(settings({ shadows }))!;
    assert.equal(round4(affine(1, g)), 1, `white holds at shadows=${shadows}`);
  }
  assert.ok(affine(0, resolveColor(settings({ shadows: 1 }))!) > 0, 'positive lifts the black point');
  assert.ok(affine(0, resolveColor(settings({ shadows: -1 }))!) < 0, 'negative crushes it');
});

test('the flattest contrast is still a picture, not a division by zero', () => {
  const g = resolveColor(settings({ contrast: -1 }))!;
  assert.ok(g.slope > 0);
  assert.ok(colorFilterStages(g).some((s) => s.startsWith('lutrgb=')));
});

// ── the ffmpeg spelling ───────────────────────────────────────────────────────

test('each stage is omitted when it is an identity', () => {
  const satOnly = colorFilterStages(resolveColor(settings({ saturation: 1.4 }))!);
  assert.ok(satOnly.some((s) => s.startsWith('colorchannelmixer=')));
  assert.ok(!satOnly.some((s) => s.startsWith('lutrgb=')), 'no affine to apply');

  const contrastOnly = colorFilterStages(resolveColor(settings({ contrast: 0.4 }))!);
  assert.ok(!contrastOnly.some((s) => s.startsWith('colorchannelmixer=')), 'no matrix to apply');
  assert.ok(contrastOnly.some((s) => s.startsWith('lutrgb=')));

  // The RGB conversion is named explicitly, and always leads.
  assert.equal(satOnly[0], 'format=gbrp');
  assert.equal(contrastOnly[0], 'format=gbrp');
});

test('the emitted filters carry plain decimals, never exponential notation', () => {
  for (const s of TABLE) {
    const grade = resolveColor(s);
    if (!grade) continue;
    for (const stage of colorFilterStages(grade)) {
      assert.ok(!/e[-+]\d/i.test(stage), stage);
    }
  }
});

test('the lut expression reproduces the affine exactly', () => {
  for (const s of TABLE) {
    const grade = resolveColor(s);
    const stage = grade && colorFilterStages(grade).find((f) => f.startsWith('lutrgb='));
    if (!grade || !stage) continue;

    for (const probe of [0, 0.25, 0.5, 0.75, 1]) {
      close(lut(probe, stage), clamp01(affine(probe, grade)), `${stage} at ${probe}`);
    }
  }
});

test('the affine holds across the whole knob grid, not only at the presets', () => {
  // This grid is why the affine is a lutrgb and not a colorlevels. colorlevels
  // says an affine as a range remap, which needs a NEGATIVE level for any lifted
  // shadow (Vintage, Faded) — and ffmpeg takes a negative level and quietly
  // produces garbage rather than rejecting it. Saying it the other way round
  // fails on mild-negative-contrast-with-crushed-shadows instead. There is no
  // form of that filter which covers this grid; there is nothing this one misses.
  for (let contrast = -1; contrast <= 1.0001; contrast += 0.05) {
    for (let shadows = -1; shadows <= 1.0001; shadows += 0.05) {
      const grade = resolveColor(settings({ contrast, shadows }));
      const stage = grade && colorFilterStages(grade).find((f) => f.startsWith('lutrgb='));
      if (!grade || !stage) continue;
      for (const probe of [0, 0.25, 0.5, 0.75, 1]) {
        close(lut(probe, stage), clamp01(affine(probe, grade)), `${stage} at ${probe}`);
      }
      // Every comma inside the expression is protected, or the graph would parse
      // as a filter that ends halfway through clip().
      assert.ok(/^lutrgb=r='[^']*':g='[^']*':b='[^']*'$/.test(stage), stage);
    }
  }
});

// ── the two spellings against each other ──────────────────────────────────────

test('the ffmpeg chain and the SVG filter carry the same numbers', () => {
  // The test that catches a drift. Parse the nine coefficients back out of the
  // filtergraph, pull them out of the feColorMatrix values, compare.
  for (const s of TABLE) {
    const grade = resolveColor(s);
    if (!grade) continue;

    const stages = colorFilterStages(grade);
    const svg = colorSvgFilter(grade);
    const values = svg.matrix.split(' ').map(Number);
    assert.equal(values.length, 20, 'feColorMatrix takes a 4x5');
    // The alpha row is untouched and there is no offset column: the grade lives
    // entirely in the 3x3, which is the only part ffmpeg can express.
    assert.deepEqual(values.slice(15), [0, 0, 0, 1, 0]);
    assert.deepEqual([values[3], values[4], values[8], values[9], values[13], values[14]], [0, 0, 0, 0, 0, 0]);

    const mixer = stages.find((f) => f.startsWith('colorchannelmixer='));
    const svgMatrix = [
      values[0], values[1], values[2],
      values[5], values[6], values[7],
      values[10], values[11], values[12],
    ];
    if (mixer) {
      const p = params(mixer);
      assert.deepEqual(
        [p.rr, p.rg, p.rb, p.gr, p.gg, p.gb, p.br, p.bg, p.bb],
        svgMatrix,
        mixer,
      );
    } else {
      assert.deepEqual(svgMatrix, [1, 0, 0, 0, 1, 0, 0, 0, 1], 'no mixer means the SVG is the identity too');
    }

    const affineStage = stages.find((f) => f.startsWith('lutrgb='));
    if (affineStage) {
      for (const probe of [0, 0.5, 1]) {
        close(lut(probe, affineStage), clamp01(probe * svg.slope + svg.intercept), affineStage);
      }
    } else {
      assert.equal(svg.slope, 1);
      assert.equal(svg.intercept, 0);
    }
  }
});

test('both spellings agree on a whole pixel, not only on their coefficients', () => {
  // Coefficient equality is the mechanism; a graded pixel is the thing the user
  // sees. Both sides are read back out of what actually ships — the filtergraph
  // string and the SVG attribute values — rather than from the Grade they were
  // built from, so this measures the same quantisation the two really carry. It
  // is also checked against the arithmetic itself, which is what would catch an
  // emitter that agreed with the other one while both were wrong.
  const PIXELS: Array<[number, number, number]> = [
    [0, 0, 0],
    [0.5, 0.5, 0.5],
    [1, 1, 1],
    [0.8, 0.4, 0.2],
    [0.1, 0.35, 0.7],
  ];

  for (const s of TABLE) {
    const grade = resolveColor(s);
    if (!grade) continue;
    const stages = colorFilterStages(grade);
    const mixer = stages.find((f) => f.startsWith('colorchannelmixer='));
    const affineStage = stages.find((f) => f.startsWith('lutrgb='));
    const svg = colorSvgFilter(grade);
    const values = svg.matrix.split(' ').map(Number);

    for (const px of PIXELS) {
      const viaSvg = [0, 5, 10].map((row) =>
        clamp01(dot(values.slice(row, row + 3), px) * svg.slope + svg.intercept),
      );
      const viaFfmpeg = mixed(px, mixer).map((v) => (affineStage ? lut(v, affineStage) : clamp01(v)));
      const reference = applyGrade(px, grade);

      for (let i = 0; i < 3; i++) {
        close(viaFfmpeg[i], viaSvg[i], `${JSON.stringify(px)} channel ${i}`);
        close(viaSvg[i], reference[i], `${JSON.stringify(px)} channel ${i} vs the arithmetic`);
      }
    }
  }
});

// ── labels ────────────────────────────────────────────────────────────────────

test('the history label names the look, and the summary says when it was tweaked', () => {
  assert.equal(colorLabel(presetSettings('warm')), 'Apply Warm look');
  assert.equal(colorLabel(DEFAULT_COLOR), 'Remove colour grade');
  assert.equal(colorSummary(DEFAULT_COLOR), 'None');
  assert.equal(colorSummary(presetSettings('warm')), 'Warm');
  assert.equal(colorSummary({ ...presetSettings('warm'), contrast: 0.5 }), 'Warm · edited');
  assert.equal(colorSummary(settings({ contrast: 0.5 })), 'Custom');
});

// ── helpers ───────────────────────────────────────────────────────────────────

const sum = (a: number, b: number) => a + b;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const dot = (row: number[], px: readonly number[]) => row[0] * px[0] + row[1] * px[1] + row[2] * px[2];

/**
 * Both emitters print at 4 decimal places, and colorlevels' input form divides
 * by (imax - imin) — which magnifies that last digit. So the two agree to within
 * a rounding step, not to the bit, and asserting equality on a rounded value
 * instead would fail on ties (0.5525 rounds two ways). A thousandth is far below
 * one step of an 8-bit channel, which is the only precision that reaches a pixel.
 */
function close(actual: number, expected: number, message: string): void {
  assert.ok(
    Math.abs(actual - expected) < 1e-3,
    `${message}: ${actual} is not within 0.001 of ${expected}`,
  );
}

/** A pixel through the emitted colorchannelmixer, or untouched without one. */
function mixed(px: readonly number[], mixer: string | undefined): number[] {
  if (!mixer) return [...px];
  const p = params(mixer);
  return [
    dot([p.rr, p.rg, p.rb], px),
    dot([p.gr, p.gg, p.gb], px),
    dot([p.br, p.bg, p.bb], px),
  ];
}

/** The affine the grade asks for, unclamped. */
function affine(v: number, grade: Grade): number {
  return v * grade.slope + grade.intercept;
}

/** The reference: matrix, then affine, then clip. What both sides must produce. */
function applyGrade(px: [number, number, number], grade: Grade): number[] {
  const m = grade.matrix;
  return [0, 3, 6].map((row) => {
    const lit = m[row] * px[0] + m[row + 1] * px[1] + m[row + 2] * px[2];
    return clamp01(affine(lit, grade));
  });
}

/** `name=a:b=c` -> { a: number, b: number }. */
function params(filter: string): Record<string, number> {
  const args = filter.slice(filter.indexOf('=') + 1);
  return Object.fromEntries(
    args.split(':').map((pair) => {
      const [k, v] = pair.split('=');
      return [k, Number(v)];
    }),
  );
}

/**
 * What lutrgb does, evaluated the way ffmpeg's expression parser would: pull the
 * red channel's clip(val*S+I*maxval,0,maxval) apart and run it on a 0..1 value.
 * Reading it back out of the emitted string rather than off the Grade is the
 * point — a typo in the expression has to fail here.
 */
function lut(v: number, stage: string): number {
  const m = /r='clip\(val\*(-?[\d.]+)([-+][\d.]+)\*maxval,0,maxval\)'/.exec(stage);
  assert.ok(m, `unparseable lut expression: ${stage}`);
  return clamp01(v * Number(m![1]) + Number(m![2]));
}
