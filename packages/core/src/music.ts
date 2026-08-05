/**
 * How long the background-music bed plays, and how it ends.
 *
 * Shared by the preview and the render on purpose. The monitor plays the bed on
 * an <audio> element and the export mixes it with ffmpeg — two completely
 * different machines that have to agree to the second, or the file does not
 * sound like what the user signed off on. Every time that arithmetic was written
 * twice it drifted; this is the one copy both sides call.
 */

/** The bed settings both sides hold — the persisted BgMusic record, narrowed. */
export interface BedSettings {
  /** The music file's own length in seconds, probed on import. */
  sourceDuration: number;
  /** A user-set length on the OUTPUT clock. Absent = run with the program. */
  durationSec?: number;
  /** See bedLoops: absent is not false. */
  loop?: boolean;
}

/**
 * Does the bed repeat to cover the program?
 *
 * ABSENT MEANS YES. A background bed is a thing you lay under a video, and a
 * five-minute track under a seven-minute cut leaving the last ninety seconds in
 * silence is not a setting anyone chose — it is the bed running out. The panel
 * already promises "it plays across the whole cut", so the default has to be the
 * thing that keeps that promise. Only an explicit `false` — the user clearing
 * the checkbox — stops it, and that reads as a deliberate "let it end".
 */
export function bedLoops(bed: BedSettings): boolean {
  return bed.loop ?? true;
}

/**
 * The bed's length on the OUTPUT clock, capped three ways: any length the user
 * set, the file's own duration, and the program. Looping lifts the middle cap —
 * that is the whole point of it — but never the program, so the bed can no more
 * outlast the picture than it can start before it.
 */
export function bedLength(bed: BedSettings, programSec: number): number {
  const fileCap = bedLoops(bed) ? Infinity : bed.sourceDuration;
  return Math.min(bed.durationSec ?? programSec, fileCap, programSec);
}

/**
 * The fade at the bed's end. 1.5s is a musical ramp rather than a de-click: a
 * song stopped at an arbitrary bar is as abrupt as any hard cut.
 */
export const DEFAULT_BED_FADE_OUT = 1.5;

/**
 * How long the bed takes to ramp out — and it is ZERO when the bed plays to the
 * end of the program.
 *
 * The fade exists to soften a song CUT SHORT: the bed stops, the video carries
 * on, and without a ramp that stop is a hole punched in the sound. When the bed
 * instead runs to the last frame there is nothing after it to ease into — the
 * file simply ends — so a fade there is not a transition, it is deleting the
 * last second and a half of the mix. The preview never faded (the element just
 * stops with the program), so this also cost the export the one property the
 * whole monitor is built around: sounding like what you heard while editing. If
 * the tail of the cut was the bed carrying a wordless closing shot, the export
 * came back with those seconds silent.
 *
 * `explicit` lets a caller ask for an outro fade anyway; only the DEFAULT is
 * suppressed. Clamped to half the bed either way, so a two-second bed does not
 * spend its whole life fading.
 */
export function bedFadeOut(bedSec: number, programSec: number, explicit?: number): number {
  // Seconds off a clock that has been through a speed divide and a float sum:
  // an exact === would call a bed that lands 0.3ms short "trimmed" and fade it.
  const reachesEnd = bedSec >= programSec - 1e-3;
  const want = explicit ?? (reachesEnd ? 0 : DEFAULT_BED_FADE_OUT);
  return Math.max(0, Math.min(want, bedSec / 2));
}
