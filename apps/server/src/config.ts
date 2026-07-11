import { fileURLToPath } from 'node:url';

/**
 * EVERY remote model id lives here and nowhere else.
 *
 * This machine has no usable GPU, so all inference is remote. That makes the
 * provider a hard dependency — and these endpoint ids and response shapes were
 * NOT verified against fal's live catalog. When one is wrong, it is wrong HERE,
 * in one line, not scattered through the codebase.
 */

/** Transcription models the user can pick between in the Transcribe panel. */
export const ASR_MODELS = [
  {
    id: 'fal-ai/whisper',
    label: 'Whisper (large-v3)',
    hint: 'Broad language coverage. Normalizes fillers away.',
    verbatim: false,
    verified: false,
  },
  {
    id: 'fal-ai/wizper',
    label: 'Wizper (fast Whisper)',
    hint: 'Faster, same family.',
    verbatim: false,
    verified: false,
  },
  {
    id: 'mock',
    label: 'Mock (no API cost)',
    hint: 'Fake words, real timings. Exercises the whole pipeline for free.',
    verbatim: true,
    verified: true,
  },
] as const;

export type AsrModelId = (typeof ASR_MODELS)[number]['id'];

/** Phase 2/3 tools. Exposed in the UI, but honestly marked as not wired. */
export const AI_TOOLS = [
  { id: 'studio-sound', label: 'Studio Sound', endpoint: '', wired: false,
    hint: 'Denoise + dereverb + enhance. Needs an audio-enhance endpoint.' },
  { id: 'overdub', label: 'Overdub (voice clone)', endpoint: '', wired: false,
    hint: 'Retype a word and have it spoken in the original voice. Needs a TTS endpoint.' },
  { id: 'translate', label: 'Translate / dub', endpoint: '', wired: false,
    hint: 'Needs a translation + cross-lingual TTS endpoint.' },
  { id: 'clips', label: 'Find clips', endpoint: '', wired: false,
    hint: 'LLM scores the transcript for self-contained moments.' },
  { id: 'green-screen', label: 'Green screen', endpoint: '', wired: false,
    hint: 'Background removal. Needs a matting endpoint.' },
] as const;

export const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  falKey: process.env.FAL_KEY ?? '',

  hasFal(): boolean {
    return Boolean(this.falKey) && process.env.ASR_PROVIDER !== 'mock';
  },

  /**
   * fileURLToPath, not .pathname — .pathname keeps URL percent-encoding, so a
   * project path containing a space resolves to a literal "%20" directory.
   */
  mediaDir: fileURLToPath(new URL('../../../media/', import.meta.url)),
};

/** Defaults for the Cuts panel. The user can change every one of these. */
export const EDIT_DEFAULTS = {
  padMs: 40,
  fadeMs: 12,
  mergeWithinMs: 20,
  maxGapMs: Infinity,
};
