import { useEffect, useRef, type RefObject } from 'react';

/**
 * Preview the Studio Sound voice chain on the monitor, mirroring the export.
 *
 * The stages match studioSoundStages in render.ts one for one where Web Audio
 * has an equivalent: the same 85Hz highpass, the same 220Hz mud dip and 3.2kHz
 * presence lift, the same 3:1 compression above -18dB with the same makeup.
 *
 * Two stages have no real-time equivalent and are deliberately absent:
 *  - afftdn/deesser. Denoising needs an FFT stage Web Audio does not ship, and a
 *    hand-rolled one would cost more than it is worth for a monitor.
 *  - loudnorm. It is an EBU R128 normaliser: it has to know the programme's
 *    integrated loudness to know its gain, which is not available while playing.
 *
 * So this is TONE-matched, not LOUDNESS-matched: it shows what the enhancer does
 * to the voice, while the export decides the absolute level. LOUDNESS_TRIM_DB
 * stands in for loudnorm's typical lift, chosen only so that switching the toggle
 * is roughly level-neutral. Without it the compressor's gain reduction goes
 * uncompensated and the enhancer makes the monitor QUIETER, which reads as the
 * feature being broken.
 *
 * Why the graph is built lazily, on first enable: createMediaElementSource takes
 * the element's audio permanently — from that call on, the element is silent
 * unless the graph reaches a destination. Building it only when the user first
 * asks for the enhancer means anyone who never touches it keeps the plain,
 * untouched <video> audio path and cannot be affected by any of this.
 */
interface Options {
  videoRef: RefObject<HTMLVideoElement | null>;
  enabled: boolean;
}

/** Mirrors `makeup=2` in the export's acompressor. */
const MAKEUP_DB = 2;
/**
 * A stand-in for loudnorm, which cannot run live. Sized so that enabling the
 * enhancer roughly cancels the compressor's gain reduction on speech rather than
 * changing the monitor's level.
 */
const LOUDNESS_TRIM_DB = 3;

const dbToGain = (db: number): number => 10 ** (db / 20);

interface Graph {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  /** The enhancer chain's head and tail, so enabling is a two-node reconnect. */
  head: AudioNode;
  tail: AudioNode;
}

export function useStudioSoundPreview({ videoRef, enabled }: Options): void {
  const graphRef = useRef<Graph | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    // Nothing to do until the user first asks for it — and until then we have
    // deliberately not captured the element. See the note above.
    if (!enabled && !graphRef.current) return;

    if (!graphRef.current) {
      const AudioCtx: typeof AudioContext | undefined =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return; // no Web Audio: the element keeps playing untouched

      let ctx: AudioContext;
      let source: MediaElementAudioSourceNode;
      try {
        ctx = new AudioCtx();
        source = ctx.createMediaElementSource(video);
      } catch {
        // A cross-origin element, or one already captured. Either way the safe
        // outcome is to leave the element's own audio path alone.
        return;
      }

      const highpass = ctx.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 85;

      const mud = ctx.createBiquadFilter();
      mud.type = 'peaking';
      mud.frequency.value = 220;
      mud.Q.value = 1.0;
      mud.gain.value = -2;

      const presence = ctx.createBiquadFilter();
      presence.type = 'peaking';
      presence.frequency.value = 3200;
      presence.Q.value = 1.2;
      presence.gain.value = 3;

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -18;
      comp.ratio.value = 3;
      comp.knee.value = 6;
      comp.attack.value = 0.008;
      comp.release.value = 0.18;

      const makeup = ctx.createGain();
      makeup.gain.value = dbToGain(MAKEUP_DB + LOUDNESS_TRIM_DB);

      // Mirrors the alimiter the render puts after the music mix: a ceiling, not
      // a sound. Below it this is transparent.
      const limiter = ctx.createDynamicsCompressor();
      limiter.threshold.value = -1;
      limiter.ratio.value = 20;
      limiter.knee.value = 0;
      limiter.attack.value = 0.001;
      limiter.release.value = 0.05;

      highpass.connect(mud).connect(presence).connect(comp).connect(makeup).connect(limiter);

      graphRef.current = { ctx, source, head: highpass, tail: limiter };
    }

    const { ctx, source, head, tail } = graphRef.current;

    source.disconnect();
    tail.disconnect();
    if (enabled) {
      source.connect(head);
      tail.connect(ctx.destination);
    } else {
      source.connect(ctx.destination);
    }

    // A context created outside a gesture starts suspended, and now that the
    // element is captured a suspended context means SILENCE. The toggle itself is
    // a gesture, so this usually resumes immediately; the listeners are the
    // fallback for every other path in, and they clean themselves up.
    if (ctx.state === 'suspended') {
      const resume = () => {
        void ctx.resume();
      };
      void ctx.resume();
      document.addEventListener('pointerdown', resume);
      document.addEventListener('keydown', resume);
      return () => {
        document.removeEventListener('pointerdown', resume);
        document.removeEventListener('keydown', resume);
      };
    }
  }, [videoRef, enabled]);

  // Close the context on unmount. The graph is not rebuilt after this — the
  // element goes with it, since App owns both.
  useEffect(() => {
    return () => {
      const graph = graphRef.current;
      graphRef.current = null;
      if (graph) void graph.ctx.close().catch(() => {});
    };
  }, []);
}
