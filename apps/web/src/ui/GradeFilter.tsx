import type { Grade } from '../../../../packages/core/src/color.ts';
import { colorSvgFilter } from '../../../../packages/core/src/color.ts';

/**
 * The colour grade, as an SVG filter something can wear.
 *
 * This is the preview half of the contract colour grading rests on. The render
 * spells a Grade as `colorchannelmixer` + `colorlevels`; this spells the SAME
 * Grade as `feColorMatrix` + `feComponentTransfer`, and colorSvgFilter hands
 * both of them the identical nine coefficients and the identical slope and
 * intercept. There is no second implementation of the arithmetic to drift —
 * color.test.ts parses the numbers back out of each and asserts they match.
 *
 * `color-interpolation-filters="sRGB"` IS NOT OPTIONAL. SVG's default is
 * linearRGB, which would have the browser do this in a different colour space
 * from ffmpeg — and it fails silently, as a preview that is simply a different
 * picture from the file. Everything else here can be got wrong loudly; this
 * cannot.
 *
 * Renders nothing at all for a neutral grade, so nothing references a filter and
 * the element it would have applied to keeps its ordinary compositing path.
 */
export default function GradeFilter({ id, grade }: { id: string; grade: Grade | null }) {
  if (!grade) return null;
  const { matrix, slope, intercept } = colorSvgFilter(grade);

  return (
    // Out of flow and out of the accessibility tree: this is a definition, not a
    // picture. width/height 0 rather than display:none, which in some engines
    // stops the filter resolving at all.
    <svg width="0" height="0" aria-hidden focusable="false" style={{ position: 'absolute' }}>
      <filter id={id} colorInterpolationFilters="sRGB">
        <feColorMatrix type="matrix" values={matrix} />
        {/* The per-channel affine: the same slope and intercept on all three,
          * because the grade's contrast and shadows are not split-toned. */}
        <feComponentTransfer>
          <feFuncR type="linear" slope={slope} intercept={intercept} />
          <feFuncG type="linear" slope={slope} intercept={intercept} />
          <feFuncB type="linear" slope={slope} intercept={intercept} />
        </feComponentTransfer>
      </filter>
    </svg>
  );
}
