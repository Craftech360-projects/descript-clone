/**
 * Colour grading: how the picture LOOKS, as opposed to what shape it is.
 *
 * The problem this solves is that a recording carries the room it was made in.
 * Office fluorescents come out green, a window comes out blue, and a phone's
 * auto-exposure comes out flat — and none of that is what the speaker looked
 * like. The other half is intent: a warm, contrasty picture reads as considered
 * even when the words are identical.
 *
 * ── why the parameter set is exactly this ────────────────────────────────────
 *
 * The grade has to be shown live in the monitor and burned into the export, and
 * those are two different machines: a browser compositing a <video>, and ffmpeg
 * pushing frames through a filtergraph. Everything else in this app dodges that
 * problem by running literally the same function in both places — compileEdl for
 * the cut, frameLayout/frameFilterStages for the crop. A grade cannot, so the
 * next best thing is to make it the same NUMBERS.
 *
 * So every knob here is chosen to collapse into one of exactly two primitives:
 *
 *   1. a 3x3 matrix over sRGB-encoded RGB   (ffmpeg colorchannelmixer / SVG feColorMatrix)
 *   2. a per-channel affine, out = in*s + c (ffmpeg colorlevels        / SVG feComponentTransfer)
 *
 * Both exist, exactly, on both sides. resolveColor computes the matrix and the
 * affine once; colorFilterStages and colorSvgFilter are thin spellings of that
 * one result. They cannot drift, and color.test.ts asserts it by parsing the
 * numbers back out of both and comparing them.
 *
 * That constraint is also why there is no curve editor, no .cube LUT import, no
 * film grain and no vignette. Each is a real grading tool and none of them
 * survives the pair — so shipping one would mean shipping a look the monitor
 * cannot show. Split-tone looks (the "teal and orange" of every trailer) go the
 * same way: the transform is hue-dependent, and a single matrix has no hue to
 * depend on.
 *
 * ── a preset is a point, not a mechanism ─────────────────────────────────────
 *
 * Every named look below is just a set of values for the same six knobs the user
 * has. Pick Warm and then raise the contrast and you get warm-with-more-contrast,
 * because there was never a second system underneath. The preset field only
 * records which point you started from, exactly as FrameSettings.preset does.
 */

export type ColorPreset =
  | 'none'
  | 'warm'
  | 'cool'
  | 'vintage'
  | 'mono'
  | 'punch'
  | 'faded'
  | 'noir'
  | 'custom';

/** The six knobs. A preset sets all of them; the sliders move within them. */
export interface ColorKnobs {
  /**
   * Stops of exposure, -1..1 — so the gain is 2^exposure and the range is half
   * to double. Stops rather than a linear percentage because that is the unit
   * the operation actually has: one step is the same perceptual change wherever
   * you are in the range, which a linear scale is not.
   *
   * Applied to the sRGB-ENCODED values, not to linear light, so it is a
   * brightness multiply and not a true photographic exposure. That is a
   * deliberate match to CSS `brightness()`, which is what the preview has.
   */
  exposure: number;
  /** -1..1, warm positive: gains red and loses blue. 0 is the source's own white. */
  temperature: number;
  /** -1..1, magenta positive / green negative — the other white-balance axis. */
  tint: number;
  /** 0..2, 1 neutral. 0 is a real greyscale on the Rec.709 luma coefficients. */
  saturation: number;
  /** -1..1, 0 neutral. A slope about mid grey: 1 is doubled, -1 is flat. */
  contrast: number;
  /**
   * -1..1, 0 neutral. Positive LIFTS the blacks (the faded, filmic look);
   * negative crushes them. White is anchored either way — see resolveColor.
   */
  shadows: number;
}

/** The document-level setting: which look, and where its knobs are. */
export interface ColorSettings extends ColorKnobs {
  preset: ColorPreset;
}

/**
 * A resolved grade: no preset left to interpret, just the two primitives.
 *
 * `matrix` is row-major 3x3, applied to sRGB-encoded RGB in 0..1. The affine
 * runs after it, on all three channels alike: out = in*slope + intercept.
 */
export interface Grade {
  matrix: [number, number, number, number, number, number, number, number, number];
  slope: number;
  intercept: number;
}

export const DEFAULT_COLOR: ColorSettings = {
  preset: 'none',
  exposure: 0,
  temperature: 0,
  tint: 0,
  saturation: 1,
  contrast: 0,
  shadows: 0,
};

/**
 * The named looks, in the order the panel offers them.
 *
 * Nothing here is extreme. A grade the user has to walk back is worse than no
 * grade at all, so each of these is aimed at "this is the shot, dressed" rather
 * than at being recognisable as an effect — the two exceptions being Mono and
 * Noir, which are the whole point of picking them.
 */
export const COLOR_PRESETS: Record<Exclude<ColorPreset, 'none' | 'custom'>, {
  label: string;
  hint: string;
  values: ColorKnobs;
}> = {
  warm: {
    label: 'Warm',
    hint: 'Golden skin, softened blues',
    values: { exposure: 0.05, temperature: 0.35, tint: 0.05, saturation: 1.08, contrast: 0.08, shadows: 0.02 },
  },
  cool: {
    label: 'Cool',
    hint: 'Clean daylight, a little crisper',
    values: { exposure: 0.02, temperature: -0.35, tint: -0.05, saturation: 1.05, contrast: 0.1, shadows: -0.02 },
  },
  vintage: {
    label: 'Vintage',
    hint: 'Warm, muted, lifted blacks',
    values: { exposure: 0.03, temperature: 0.22, tint: 0.08, saturation: 0.78, contrast: -0.08, shadows: 0.35 },
  },
  mono: {
    label: 'Mono',
    hint: 'Black and white',
    values: { exposure: 0.02, temperature: 0, tint: 0, saturation: 0, contrast: 0.15, shadows: 0 },
  },
  punch: {
    label: 'Punch',
    hint: 'Saturated and contrasty',
    values: { exposure: 0.03, temperature: 0.05, tint: 0, saturation: 1.3, contrast: 0.28, shadows: -0.15 },
  },
  faded: {
    label: 'Faded',
    hint: 'Matte blacks, low contrast',
    values: { exposure: 0.06, temperature: 0.05, tint: 0.03, saturation: 0.85, contrast: -0.15, shadows: 0.55 },
  },
  noir: {
    label: 'Noir',
    hint: 'High-contrast black and white',
    values: { exposure: -0.05, temperature: 0, tint: 0, saturation: 0, contrast: 0.45, shadows: -0.35 },
  },
};

export const MIN_SATURATION = 0;
export const MAX_SATURATION = 2;

/**
 * Rec.709 luma coefficients — what a pixel's brightness is, for the purpose of
 * desaturating towards it.
 *
 * These are stated here rather than borrowed from either implementation, and
 * that is the point. ffmpeg's own `eq=saturation` works in YUV against whatever
 * matrix the stream is tagged with, and the SVG spec's `type="saturate"` carries
 * its own rounded constants; either would put the preview and the render on
 * different numbers. Building the matrix ourselves and handing the SAME nine
 * coefficients to both is what removes the question.
 */
const LUMA = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** How far temperature pulls red against blue at full travel. */
const TEMP_GAIN = 0.2;
/** How far tint pulls green against the other two at full travel. */
const TINT_GAIN = 0.15;
/** How far the shadows knob lifts or crushes the black point at full travel. */
const SHADOW_LIFT = 0.15;
/**
 * The flattest slope that is still a picture.
 *
 * contrast -1 works out to a slope of exactly 0 — every pixel becomes the same
 * grey — and colorlevels cannot express that, because the range it maps onto
 * would be empty. 0.05 is visually the same mush and is a range the filter
 * accepts.
 */
const MIN_SLOPE = 0.05;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Coerce anything off the wire or off disk into a usable ColorSettings.
 *
 * Per field, not per object — the same contract as normalizeFrame and
 * normalizeCaptions. A project saved before one of these knobs existed picks up
 * the default for that knob alone rather than losing the five it does have.
 */
export function normalizeColor(input?: Partial<ColorSettings> | null): ColorSettings {
  const c = input ?? {};
  const preset: ColorPreset =
    c.preset === 'custom' || (c.preset && c.preset in COLOR_PRESETS) ? (c.preset as ColorPreset) : 'none';

  // 'none' is neutral BY DEFINITION, so it never reads the stored numbers — the
  // same rule that makes a fixed frame preset own its size rather than inheriting
  // a stale custom one.
  if (preset === 'none') return { ...DEFAULT_COLOR };

  return {
    preset,
    exposure: clamp(num(c.exposure, 0), -1, 1),
    temperature: clamp(num(c.temperature, 0), -1, 1),
    tint: clamp(num(c.tint, 0), -1, 1),
    saturation: clamp(num(c.saturation, 1), MIN_SATURATION, MAX_SATURATION),
    contrast: clamp(num(c.contrast, 0), -1, 1),
    shadows: clamp(num(c.shadows, 0), -1, 1),
  };
}

/** The settings a named look stands for, ready to hand to setColor. */
export function presetSettings(preset: ColorPreset): ColorSettings {
  if (preset === 'none' || preset === 'custom') return { ...DEFAULT_COLOR, preset };
  return { preset, ...COLOR_PRESETS[preset].values };
}

/**
 * Resolve a setting into the matrix and the affine, or null if it would change
 * nothing.
 *
 * Null is the important half, exactly as it is in resolveFrame. A neutral grade
 * still spelled out as filters would convert every frame to planar RGB, multiply
 * it by the identity, and convert it back — a full-rate re-encode to produce the
 * pixels it was already holding. Callers treat null as "emit nothing", and that
 * is what keeps a project which never opens this panel byte-identical to one
 * from before grading existed.
 *
 * The composition, in order:
 *
 *  - Exposure and white balance are both DIAGONAL: a per-channel gain. 2^exposure
 *    on all three, then temperature opposing red against blue and tint opposing
 *    green against the pair.
 *  - Saturation is a full 3x3 that pulls each channel towards the luma. It goes
 *    LAST of the three, i.e. outermost, so it saturates the balanced picture
 *    rather than the raw one — desaturating a warm grade should take the warmth
 *    with it, which it does only in this order.
 *  - Multiplying a matrix by a diagonal on the right is a column scale, which is
 *    why this needs no general matrix multiply.
 *
 * Then the affine, which is two moves composed:
 *
 *  - Contrast is a slope about MID GREY: out = (in - 0.5)*s + 0.5.
 *  - Shadows is a slope about WHITE: out = in*(1 - L) + L. One formula covers
 *    both directions — positive L lifts the black point and leaves white at 1,
 *    negative L crushes it and still leaves white at 1. Anchoring on white is
 *    what stops a lift from clipping the highlights it never meant to touch.
 */
export function resolveColor(color: ColorSettings): Grade | null {
  const c = normalizeColor(color);

  const gain = Math.pow(2, c.exposure);
  const tempR = 1 + TEMP_GAIN * c.temperature;
  const tempB = 1 - TEMP_GAIN * c.temperature;
  const tintG = 1 - TINT_GAIN * c.tint;
  const tintRB = 1 + (TINT_GAIN / 2) * c.tint;

  // The diagonal: one gain per channel, exposure and white balance folded together.
  const d = [gain * tempR * tintRB, gain * tintG, gain * tempB * tintRB];

  // The saturate matrix, on the coefficients above. At s=1 this is the identity;
  // at s=0 every row is the luma, which is the greyscale.
  const s = c.saturation;
  const sat = [
    LUMA.r + s * (1 - LUMA.r), LUMA.g * (1 - s), LUMA.b * (1 - s),
    LUMA.r * (1 - s), LUMA.g + s * (1 - LUMA.g), LUMA.b * (1 - s),
    LUMA.r * (1 - s), LUMA.g * (1 - s), LUMA.b + s * (1 - LUMA.b),
  ];

  // sat * diag(d): scale column j by d[j].
  const matrix = sat.map((v, i) => v * d[i % 3]) as Grade['matrix'];

  const contrastSlope = 1 + c.contrast;
  const contrastIntercept = 0.5 * (1 - contrastSlope);
  const lift = SHADOW_LIFT * c.shadows;
  const shadowSlope = 1 - lift;
  const shadowIntercept = lift;

  const slope = Math.max(MIN_SLOPE, contrastSlope * shadowSlope);
  const intercept = contrastIntercept * shadowSlope + shadowIntercept;

  if (isIdentity(matrix) && isUnitAffine(slope, intercept)) return null;
  return { matrix, slope, intercept };
}

const EPS = 1e-6;
const IDENTITY: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function isIdentity(matrix: readonly number[]): boolean {
  return matrix.every((v, i) => Math.abs(v - IDENTITY[i]) < EPS);
}

function isUnitAffine(slope: number, intercept: number): boolean {
  return Math.abs(slope - 1) < EPS && Math.abs(intercept) < EPS;
}

/**
 * The filtergraph stages that apply a grade.
 *
 * Each stage is omitted when it is an identity, so a grade that only moves the
 * saturation emits one filter rather than three.
 *
 * `format=gbrp` is explicit rather than left to ffmpeg's own negotiation. The
 * filters below are RGB filters and ffmpeg would insert a conversion anyway, but
 * naming it means the graph is the same one on every source pixel format instead
 * of whatever the auto-inserted scaler picked — and the encoder's -pix_fmt
 * yuv420p converts back on the way out.
 */
export function colorFilterStages(grade: Grade): string[] {
  const identity = isIdentity(grade.matrix);
  const unit = isUnitAffine(grade.slope, grade.intercept);
  if (identity && unit) return [];

  const stages = ['format=gbrp'];
  if (!identity) {
    const [rr, rg, rb, gr, gg, gb, br, bg, bb] = grade.matrix;
    stages.push(
      `colorchannelmixer=rr=${n(rr)}:rg=${n(rg)}:rb=${n(rb)}:` +
        `gr=${n(gr)}:gg=${n(gg)}:gb=${n(gb)}:` +
        `br=${n(br)}:bg=${n(bg)}:bb=${n(bb)}`,
    );
  }
  if (!unit) stages.push(affineStage(grade.slope, grade.intercept));
  return stages;
}

/**
 * `out = in*slope + intercept`, spelled as a lutrgb.
 *
 * lutrgb evaluates its expression ONCE PER LEVEL to build a 256-entry table, so
 * this costs a table lookup per pixel at render time however involved the
 * expression is — cheaper than the arithmetic it replaces, not more expensive.
 *
 * The obvious filter for this is `colorlevels`, and it was the first thing here.
 * It cannot do the job. It expresses an affine as a range remap, which needs
 * `imin = -c/s` — a NEGATIVE level whenever the intercept is positive, i.e.
 * whenever the shadows are lifted, i.e. Vintage and Faded. ffmpeg accepts a
 * negative level and then produces garbage: `rimin=-0.1364` turns mid grey pure
 * black and turns a colour into a different colour, which is the signature of the
 * value wrapping through an unsigned type rather than being clamped. Saying it
 * the other way round — moving the output range instead — covers that case but
 * fails its own: a mild negative contrast with crushed shadows wants `omin` below
 * zero and hits exactly the same wall. There is a band of ordinary grades that
 * NEITHER form can express, so the two-form dance was not a fix, only a smaller
 * bug. (Nor does depth help: colorlevels scales its 0..1 parameters against an
 * 8-bit maximum whatever the pixel format, so the identical filter at gbrp10le
 * blows mid grey to white.) All verified against ffmpeg 8.1.
 *
 * lutrgb has none of those constraints, because it is given the arithmetic rather
 * than a range to infer it from.
 *
 * The expression is SINGLE-QUOTED and the commas inside clip() are left alone.
 * The filtergraph parser splits on commas before it ever looks at an option
 * value, so an unquoted one ends the filter mid-expression — and escaping them
 * instead does not survive, which is the same lesson (and the same fix) as
 * `subtitles=filename='…'` in render.ts.
 */
function affineStage(slope: number, intercept: number): string {
  // maxval, not 255: lutrgb hands the expression the format's own maximum, so
  // this stays correct if the conversion above ever changes depth.
  const offset = `${intercept < 0 ? '-' : '+'}${n(Math.abs(intercept))}*maxval`;
  const expr = `'clip(val*${n(slope)}${offset},0,maxval)'`;
  // The same expression on all three channels: the grade's contrast and shadows
  // are not split-toned, and everything per-channel lives in the matrix above.
  return `lutrgb=r=${expr}:g=${expr}:b=${expr}`;
}

/**
 * The same grade, as the two SVG filter primitives the preview wears.
 *
 * `matrix` is feColorMatrix's 4x5 `values`: the 3x3 above with an untouched
 * alpha row and no offset column. `slope`/`intercept` go on the three
 * feFuncR/G/B children of an feComponentTransfer, type="linear".
 *
 * THE FILTER ELEMENT MUST CARRY color-interpolation-filters="sRGB". SVG's
 * default is linearRGB, which would have the browser do this arithmetic in a
 * different space from ffmpeg — and the failure mode is not an error, it is a
 * preview that is quietly a different picture from the export.
 */
export function colorSvgFilter(grade: Grade): { matrix: string; slope: number; intercept: number } {
  const [rr, rg, rb, gr, gg, gb, br, bg, bb] = grade.matrix;
  const matrix = [
    rr, rg, rb, 0, 0,
    gr, gg, gb, 0, 0,
    br, bg, bb, 0, 0,
    0, 0, 0, 1, 0,
  ]
    .map(n)
    .join(' ');
  return { matrix, slope: Number(n(grade.slope)), intercept: Number(n(grade.intercept)) };
}

/** A label for the history entry a colour change writes. */
export function colorLabel(color: ColorSettings): string {
  if (color.preset === 'none') return 'Remove colour grade';
  if (color.preset === 'custom') return 'Adjust colour';
  return `Apply ${COLOR_PRESETS[color.preset].label} look`;
}

/** What the panel's closed row says. States the look, and that it was tweaked. */
export function colorSummary(color: ColorSettings): string {
  const c = normalizeColor(color);
  if (c.preset === 'none') return 'None';
  if (c.preset === 'custom') return 'Custom';
  const base = COLOR_PRESETS[c.preset].values;
  const tweaked = (Object.keys(base) as Array<keyof ColorKnobs>).some(
    (k) => Math.abs(base[k] - c[k]) > EPS,
  );
  return tweaked ? `${COLOR_PRESETS[c.preset].label} · edited` : COLOR_PRESETS[c.preset].label;
}

/**
 * ffmpeg wants plain decimals, never exponential notation — and 4 places is the
 * precision both emitters round to, so the two are compared at the same
 * precision rather than one of them carrying float noise the other does not.
 */
function n(value: number): string {
  return value.toFixed(4);
}
