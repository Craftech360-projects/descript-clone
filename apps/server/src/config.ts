import { fileURLToPath } from 'node:url';

/**
 * EVERY remote model id lives here and nowhere else.
 *
 * This machine has no usable GPU, so transcription is remote. That makes the
 * provider a hard dependency — so when it is wrong, it is wrong HERE, in one
 * line, not scattered through the codebase.
 *
 * Verified against the live API on 2026-07-16 with a 3s flite-synthesised clip:
 * `scribe_v1` is a real id, `timestamps_granularity: 'word'` is honoured, and
 * the response carries `words[]` with per-word `start`/`end` in SECONDS plus
 * `speaker_id`. `language_code` and `num_speakers` are both accepted. That is
 * the whole assumption this product rests on, and it holds.
 */

/** The ElevenLabs speech-to-text endpoint. One call: the body is the audio. */
export const ASR_ENDPOINT = 'https://api.elevenlabs.io/v1/speech-to-text';

/**
 * Transcription models the user can pick between in the Transcribe panel.
 *
 * Whisper and Wizper are gone with fal. They were hosted there, and reaching
 * them now would mean a second provider and a second key — for models that
 * report verbatim:false, i.e. that normalize away the fillers this product
 * exists to remove. Losing them costs the product nothing it was using.
 */
export const ASR_MODELS = [
  {
    id: 'scribe_v1',
    label: 'ElevenLabs Scribe',
    hint: 'Verbatim: keeps "um"/"uh" as spoken. Word timings + diarization. Filler removal needs this.',
    verbatim: true,
    verified: true,
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

/**
 * The unbuilt tools — Studio Sound, Overdub, Translate, Find clips, Green
 * screen — used to be served to the client and rendered as five permanently
 * disabled rows with "not wired" badges.
 *
 * The defence was that a button that pretends is worse than one that admits.
 * That is half right, and it is the wrong half: the honest artifact for an
 * unbuilt feature is a roadmap, not a disabled control shipped into the surface
 * where every user pays its cognitive cost forever. They live in the README now.
 * The warn-box voice stays everywhere it describes something real.
 */

export const CONFIG = {
  port: Number(process.env.PORT ?? 8787),
  elevenLabsKey: process.env.ELEVENLABS_API_KEY ?? '',

  /**
   * Optional, and the music picker works without it — Openverse needs no key at
   * all, so a fresh clone can search on first run. Setting this (free, instant,
   * from devportal.jamendo.com) swaps in a far larger catalogue, an instrumental
   * filter Openverse cannot express, and no 200-searches-a-day ceiling. See
   * music-search.ts.
   */
  jamendoClientId: process.env.JAMENDO_CLIENT_ID ?? '',

  /**
   * Where the ffmpeg/ffprobe binaries live. A bare name is resolved off PATH,
   * which is right for dev and the Docker image where both are installed
   * system-wide. The desktop build has no such guarantee — it sets these to the
   * binaries it ships, so the app never depends on the user having ffmpeg. `||`
   * (not `??`) so an empty env var falls back rather than spawning "".
   */
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe',

  /** Whether real transcription is available. Without it, the mock provider runs. */
  hasAsr(): boolean {
    return Boolean(this.elevenLabsKey) && process.env.ASR_PROVIDER !== 'mock';
  },

  /**
   * fileURLToPath, not .pathname — .pathname keeps URL percent-encoding, so a
   * project path containing a space resolves to a literal "%20" directory.
   *
   * MEDIA_DIR overrides it so a container can point this at a mounted volume:
   * the default sits inside the source tree, which is exactly where state must
   * NOT live when the filesystem is ephemeral.
   */
  mediaDir: process.env.MEDIA_DIR ?? fileURLToPath(new URL('../../../media/', import.meta.url)),

  /**
   * Serve the built web app from this server when set, so one container is the
   * whole product. Unset in dev, where Vite serves the UI and proxies /api here.
   */
  webDist: process.env.WEB_DIST ?? '',

  /**
   * Hard cap on an upload. The import route buffers the entire file in memory
   * before it touches disk, so an unbounded upload is an unbounded allocation —
   * this is the difference between a rejected request and a killed container.
   */
  maxUploadBytes: Number(process.env.MAX_UPLOAD_MB ?? 512) * 1024 * 1024,
};

/** Defaults for the Cuts panel. The user can change every one of these. */
export const EDIT_DEFAULTS = {
  padMs: 40,
  fadeMs: 12,
  mergeWithinMs: 20,
  maxGapMs: Infinity,
};
