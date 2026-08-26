/**
 * What a sideways drag on a dismissable banner MEANT.
 *
 * Split out from the component, and kept free of React, for two reasons: it is
 * the only part of the gesture that can be wrong in a way a person notices, and
 * a .tsx file cannot be loaded by `node --test` (it does not parse JSX).
 */

/** Travel, in px, past which a drag counts as "throw this away" rather than a nudge. */
export const ESCAPE = 72;
/** Under this much movement the gesture was a tap, not a drag. */
export const STILL = 6;

export type Verdict =
  /** Thrown off the left edge. */
  | 'left'
  /** Thrown off the right edge. */
  | 'right'
  /** Barely moved — the old tap-to-dismiss. */
  | 'tap'
  /** Dragged, but not far enough to mean it. Spring back. */
  | 'stay';

/**
 * @param offset  where the finger ended up, relative to where it went down.
 *                Signed: negative is leftward.
 * @param travelled  the FURTHEST the finger got during the gesture, unsigned.
 *                   Not the same as |offset| — a drag out and back ends near
 *                   zero, and must not be mistaken for a tap.
 */
export function verdictFor(offset: number, travelled: number): Verdict {
  if (Math.abs(offset) > ESCAPE) return offset > 0 ? 'right' : 'left';
  if (travelled < STILL) return 'tap';
  return 'stay';
}
