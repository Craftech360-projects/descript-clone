import { useEffect, type RefObject } from 'react';
import { sourceToOutput } from '../../../../packages/core/src/edl.ts';
import type { Edl } from '../../../../packages/core/src/types.ts';

/**
 * Play the background-music bed in the monitor, on the OUTPUT clock.
 *
 * The bed is not part of the source: it belongs to the finished, cut, re-timed
 * program, exactly as the render mixes it. So this does NOT track the <video>'s
 * source time — it tracks OUTPUT time (source time mapped through the EDL), which
 * is the same clock the bed will sit on in the export. The music element runs
 * free and this only nudges it back when it drifts, rather than reseeking every
 * frame (which would stutter the audio).
 *
 * Rate: the preview plays the program at `speed`, so output time advances `speed`
 * times faster than the wall clock; the bed's element matches with playbackRate =
 * speed and preservesPitch, so it stays aligned without chipmunking. At the usual
 * 1x this is exact; the only divergence from the export — where the bed plays at
 * its natural 1x under a program stretched to fit — appears when previewing a
 * sped edit, which is itself a sped preview of everything else too.
 */
interface Options {
  musicRef: RefObject<HTMLAudioElement | null>;
  edl: Edl | null;
  playing: boolean;
  /** Document speed — drives the element's rate, same as the video's. */
  speed: number;
  /** The global source clock, read imperatively (the same one the video uses). */
  getCurrentTime: () => number;
  /** Linear volume 0..N. The element caps the preview at 1; the export does not. */
  volume: number;
  /** The bed's length on the output clock, in seconds. 0 disables the bed. */
  endSec: number;
  /** Loop the file to fill `endSec` — mirrors the render's `-stream_loop`. */
  loop: boolean;
  /** The file's own length, in seconds — the modulus a looped position wraps at. */
  sourceDuration: number;
  /**
   * Seconds of ramp at the bed's end, from the same bedFadeOut the render calls.
   * Zero when the bed plays to the last frame, which is the usual case — the
   * element then just stops with the program, exactly as it always did.
   */
  fadeOutSec?: number;
}

export function useMusicPreview({
  musicRef,
  edl,
  playing,
  speed,
  getCurrentTime,
  volume,
  endSec,
  loop,
  sourceDuration,
  fadeOutSec = 0,
}: Options): void {
  // Volume, rate, and the element's own loop flag follow the controls in every
  // state — paused, scrubbing, or playing — so a change is heard at once. The
  // native loop flag keeps the file repeating as it free-runs between reseeks.
  //
  // The fade below writes el.volume too, so the dialled-in level is kept here for
  // it to scale rather than read back off the element it is currently ramping.
  const level = Math.min(1, Math.max(0, volume));
  useEffect(() => {
    const el = musicRef.current;
    if (!el) return;
    el.volume = level;
    /**
     * The bed plays at its OWN tempo, never the program's.
     *
     * The export never time-stretches the music: it mixes it under the finished
     * program at 1x (see bgMusicMixLines — the graph runs atempo on the PROGRAM
     * and hands the bed straight to amix). Matching the program's rate here made
     * the preview lie about the one thing you use it for — deciding whether a
     * piece of music works — because you were auditioning it 1.2x fast.
     *
     * The cost, stated plainly: output time advances faster than the bed does,
     * so during a long sped preview the bed slips behind where the export will
     * have it. It is re-anchored on every seek (see the scrub branch below).
     * Hearing the wrong SECOND of a bed is a much smaller lie than hearing every
     * second of it at the wrong tempo.
     */
    el.defaultPlaybackRate = 1;
    el.playbackRate = 1;
    el.preservesPitch = true;
    el.loop = loop;
  }, [musicRef, level, speed, loop]);

  useEffect(() => {
    const el = musicRef.current;
    if (!el || !edl || endSec <= 0) return;
    if (!playing) {
      el.pause();
      return;
    }

    let raf = 0;
    // Wider than a frame so ordinary rate jitter does not trigger a reseek; a
    // reseek is a decode and would click. Only a real divergence (a scrub, a cut
    // skip, the bed never having started) crosses it.
    const DRIFT = 0.3;
    // The previous frame's output time, so a SCRUB can be told from the steady
    // slip that a sped preview causes. Only the former is worth a reseek; the
    // latter is expected and correcting it would click several times a second.
    let lastOut: number | null = null;

    const frame = () => {
      raf = requestAnimationFrame(frame);
      const out = sourceToOutput(edl, getCurrentTime());
      if (out === null) return; // inside a cut the player is skipping over
      if (out >= endSec) {
        if (!el.paused) el.pause(); // the bed has run its length
        el.volume = level; // ready at full level for the next play
        return;
      }
      // The ramp the render burns in, so a bed that stops before the picture does
      // eases out here too instead of vanishing mid-bar. fadeOutSec is 0 whenever
      // the bed plays to the end, and this whole branch is then dead.
      if (fadeOutSec > 0) {
        const left = endSec - out;
        el.volume = left < fadeOutSec ? level * (left / fadeOutSec) : level;
      }
      // Where in the FILE that output moment sits: the bed advances with output
      // time, wrapping at the file's length when looping so a 30s track keeps
      // covering a longer program.
      const target = loop && sourceDuration > 0 ? out % sourceDuration : out;
      // Compare against the wrapped position too, but forgive a near-wrap where
      // currentTime just reset to ~0 while `target` is near sourceDuration.
      const drift = Math.abs(el.currentTime - target);
      const wrapped = loop && sourceDuration > 0 && drift > sourceDuration - DRIFT;
      // A jump in OUTPUT time is a scrub, a cut skip, or a fresh start — the bed
      // has to be re-anchored to the moment the picture is now at. Ordinary
      // advance, however far the bed has slipped behind, is left alone.
      const jumped = lastOut === null || Math.abs(out - lastOut) > DRIFT;
      lastOut = out;
      if (el.paused || (jumped && drift > DRIFT && !wrapped)) {
        el.currentTime = target;
        void el.play().catch(() => {});
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      el.pause();
    };
  }, [musicRef, edl, playing, endSec, speed, getCurrentTime, loop, sourceDuration, fadeOutSec, level]);
}
