/**
 * EVERY remote model id lives here and nowhere else.
 *
 * The machine this runs on has no usable GPU, so all inference is remote. That
 * makes the provider a hard dependency — and the exact endpoint ids and response
 * shapes below were NOT verified against fal's live catalog. They are the most
 * likely values. When one is wrong, it is wrong HERE, in one line, and not
 * scattered through the codebase.
 *
 * Verify in this order — only the first one blocks Phase 1:
 *   1. asr        — does it return WORD-level timestamps? Everything depends on this.
 *   2. asr.diarize — speaker labels. Nice to have; the editor works without them.
 *   3. the rest   — Phase 2/3, not needed yet.
 */

import { fileURLToPath } from 'node:url';

export interface ModelConfig {
  endpoint: string;
  notes: string;
}

export const MODELS = {
  /**
   * THE LOAD-BEARING ONE. Text-based editing is impossible without per-word
   * [start, end]. Segment-level timestamps are not a substitute — they would
   * let you cut sentences, not words, which is a different (worse) product.
   * If this endpoint cannot do word level, the fallback is a forced-alignment
   * pass (WhisperX-style) on top of any transcript.
   */
  asr: {
    endpoint: 'fal-ai/whisper',
    notes: 'Expects { chunk_level: "word" } and chunks[] with [start,end]. UNVERIFIED.',
  },

  /** Phase 1 stretch: verbatim ASR that preserves "um"/"uh" (CrisperWhisper-class). */
  asrVerbatim: {
    endpoint: 'fal-ai/whisper',
    notes: 'Standard ASR NORMALIZES fillers away. Without a verbatim model, filler removal finds nothing. UNVERIFIED whether fal hosts one.',
  },

  /** Phase 2. */
  tts: { endpoint: 'fal-ai/f5-tts', notes: 'Voice cloning / Overdub. UNVERIFIED.' },
  enhance: { endpoint: 'fal-ai/audio-enhance', notes: 'Studio Sound. UNVERIFIED.' },

  /** Phase 3. */
  lipsync: { endpoint: 'fal-ai/latentsync', notes: 'Video Regenerate. UNVERIFIED.' },
  matting: { endpoint: 'fal-ai/birefnet', notes: 'Green screen. UNVERIFIED.' },
} satisfies Record<string, ModelConfig>;

export const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  falKey: process.env.FAL_KEY ?? '',
  /**
   * With no key, the server uses a mock ASR provider. This is not a toy: it lets
   * the entire pipeline — ingest, transcript, EDL, ffmpeg render — be developed
   * and verified end to end at zero API cost. Only the words are fake.
   */
  get provider(): 'fal' | 'mock' {
    return process.env.ASR_PROVIDER === 'mock' || !this.falKey ? 'mock' : 'fal';
  },
  /**
   * fileURLToPath, not .pathname — .pathname keeps URL percent-encoding, so a
   * project path containing a space resolves to a literal "%20" directory.
   */
  mediaDir: fileURLToPath(new URL('../../../media/', import.meta.url)),
};

export const EDIT_DEFAULTS = {
  padMs: 40,
  fadeMs: 12,
  mergeWithinMs: 20,
};
