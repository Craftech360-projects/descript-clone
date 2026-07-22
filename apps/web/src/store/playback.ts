import { useEffect, type RefObject } from 'react';
import { lookaheadFor, playStep } from '../../../../packages/core/src/timeline.ts';
import type { Edl } from '../../../../packages/core/src/types.ts';

/**
 * Play the edit: skip cut material as it comes, without letting any of it out.
 *
 * The decision of WHAT to do lives in core's `playStep`, which is pure and
 * tested — same reason compileEdl is pure. This hook only does the parts that
 * need a browser: run a clock, move the playhead, gate the audio.
 *
 * What was wrong before: the skip hung off `timeupdate`, which fires at ~4Hz,
 * and it reacted rather than predicted — it asked "am I inside a cut?" and so
 * only found out up to 250ms after it already was. You heard a quarter second
 * of every word you had deleted; after a 200-cut filler sweep, 200 ghosts.
 *
 * rAF and not requestVideoFrameCallback: rVFC is unimplemented in Firefox, and
 * it only fires when a video frame is presented — so for the audio-only projects
 * this app explicitly supports it would never fire at all.
 *
 * Running on rAF means this asks the question 60 times a second, and a seek
 * takes far longer than a frame to answer. Everything that jumps the playhead
 * therefore has to be idempotent across the frames it is still in flight for —
 * see the `video.seeking` guard, which is load-bearing, not a micro-optimisation.
 */

interface Options {
  /** The ref, not the element: a ref assignment does not re-render, so reading
   *  `.current` at call time would latch this effect onto the initial null. */
  videoRef: RefObject<HTMLVideoElement | null>;
  edl: Edl | null;
  followEdit: boolean;
  playing: boolean;
  /** Document speed. Drives the element's rate AND the skip loop's margin. */
  speed: number;
  onEnded: () => void;
}

export function usePlayback({ videoRef, edl, followEdit, playing, speed, onEnded }: Options): void {
  /**
   * Rate is its own effect because it is not a property of PLAYING.
   *
   * The skip loop below only mounts while playing, following the edit, with an
   * EDL. The rate has to hold in all the states that is not: paused, scrubbing,
   * previewing the raw source. Setting it in there would leave the element at 1x
   * whenever the loop was absent, and the monitor would disagree with the export.
   */
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    // defaultPlaybackRate as well, and not for symmetry: load() resets
    // playbackRate BACK to defaultPlaybackRate, and opening another project
    // changes src on this same element. Setting only the live rate means the
    // next project silently plays at 1x while the transport still reads 1.2x.
    video.defaultPlaybackRate = speed;
    video.playbackRate = speed;
    // Match ffmpeg's atempo, which time-stretches without pitching. Chrome's
    // default is already true, but leaving it implicit means the preview's pitch
    // and the render's pitch agree only by coincidence.
    video.preservesPitch = true;
  }, [videoRef, speed]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !edl || !followEdit || !playing) return;
    if (edl.keep.length === 0) return;

    let raf = 0;
    let restoreVolume: number | null = null;
    // Drops every listener this effect added, however it unwinds. The old code
    // removed the 'seeked' handler only from inside itself, so tearing down
    // mid-seek — i.e. editing while playing — stranded it on the element, where
    // it would later fire against a jump it knew nothing about and unmute in the
    // middle of it.
    const seekedGate = new AbortController();

    /** Mute across the jump, then restore once the browser says it landed. */
    const gate = (to: number, silent: boolean) => {
      if (silent && restoreVolume === null) {
        restoreVolume = video.volume;
        video.volume = 0;
        const done = () => {
          if (restoreVolume !== null) {
            video.volume = restoreVolume;
            restoreVolume = null;
          }
        };
        video.addEventListener('seeked', done, { once: true, signal: seekedGate.signal });
      }
      video.currentTime = to;
    };

    const frame = () => {
      raf = requestAnimationFrame(frame);

      // A seek is not instant, and this is the whole reason playback used to
      // hang. `seeking` stays true until the decoder lands — ~16ms from a local
      // file, but ~600ms streaming over HTTP, which is ~35 of these frames. The
      // spec is explicit that assigning currentTime mid-seek ABORTS the seek in
      // flight and starts another, and Chrome keeps reporting the OLD position
      // until one completes. So the unguarded loop read a stale time, concluded
      // it still had to jump, and killed the seek that was about to land — sixty
      // times a second, forever. Measured on the 885s sample after an 18-word
      // cut: 1665 seeks started, 1 completed, playhead frozen at 23.2s for the
      // whole 27s that was left. Let the browser finish; it is already going
      // where we asked.
      if (video.seeking) return;

      // The margin scales with the rate — at 2x the playhead covers 33ms between
      // frames, and a fixed 30ms lookahead would be a frame too late. See
      // lookaheadFor.
      const step = playStep(edl, video.currentTime, lookaheadFor(speed));
      if (step.action === 'continue') return;
      if (step.action === 'seek') return gate(step.to, step.silent);

      // The edit is over. Stop the loop with it — otherwise it keeps calling
      // pause() and onEnded() every frame until React gets around to unmounting.
      cancelAnimationFrame(raf);
      video.pause();
      onEnded();
    };

    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      seekedGate.abort();
      // Never strand the element muted if we unmount mid-seek.
      if (restoreVolume !== null) video.volume = restoreVolume;
    };
  }, [videoRef, edl, followEdit, playing, speed, onEnded]);
}
