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
export const SARVAM_ASR_ENDPOINT = 'https://api.sarvam.ai';

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
    provider: 'elevenlabs',
    label: 'ElevenLabs Scribe',
    hint: 'Verbatim: keeps "um"/"uh" as spoken. Word timings + diarization. Filler removal needs this.',
    verbatim: true,
    verified: true,
  },
  {
    id: 'saaras_v3',
    provider: 'sarvam',
    label: 'Sarvam Saaras v3',
    hint: 'Indic-language ASR with verbatim mode. Phrase timings are distributed across words for editing.',
    verbatim: true,
    verified: true,
  },
  {
    id: 'mock',
    provider: 'mock',
    label: 'Mock (no API cost)',
    hint: 'Fake words, real timings. Exercises the whole pipeline for free.',
    verbatim: true,
    verified: true,
  },
] as const;

export type AsrModelId = (typeof ASR_MODELS)[number]['id'];
export type AsrProviderId = (typeof ASR_MODELS)[number]['provider'];

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

  // The credential fields below are GETTERS, not captured values, so a key set at
  // runtime from the dashboard (which writes process.env — see settings.ts) takes
  // effect on the very next request without a restart. The Claude SDK reads
  // process.env itself, so writing there is what makes both backends live-editable.
  // The desktop build can bake a fallback key in at compile time (see
  // desktop/*/build.mjs) so a shipped app works before anyone opens the
  // dashboard. That define targets __BAKED_ELEVENLABS_KEY__ only — never
  // ELEVENLABS_API_KEY itself — so a key set later from the dashboard, which
  // writes process.env.ELEVENLABS_API_KEY, always wins over whatever was
  // baked in and is never frozen to it.
  get elevenLabsKey() {
    return process.env.ELEVENLABS_API_KEY || process.env.__BAKED_ELEVENLABS_KEY__ || '';
  },

  /** Sarvam API key for Saaras v3 speech-to-text. Runtime-editable like the ElevenLabs key. */
  get sarvamApiKey() {
    return process.env.SARVAM_API_KEY || process.env.__BAKED_SARVAM_KEY__ || '';
  },

  /**
   * Optional, and the music picker works without it — Openverse needs no key at
   * all, so a fresh clone can search on first run. Setting this (free, instant,
   * from devportal.jamendo.com) swaps in a far larger catalogue, an instrumental
   * filter Openverse cannot express, and no 200-searches-a-day ceiling. See
   * music-search.ts.
   */
  get jamendoClientId() {
    return process.env.JAMENDO_CLIENT_ID ?? '';
  },

  /**
   * The AI assistant (Grok, via xAI). The key is the only hard requirement — the
   * assistant is off until it is set, exactly like ASR without ELEVENLABS_API_KEY.
   * xAI's Chat Completions API is OpenAI-compatible, so the base URL and model id
   * are the whole configuration; XAI_MODEL only sets the DEFAULT — the user picks
   * a model per session in the chat panel.
   */
  get xaiKey() {
    return process.env.XAI_API_KEY ?? '';
  },
  xaiBaseUrl: process.env.XAI_BASE_URL || 'https://api.x.ai/v1',
  xaiModel: process.env.XAI_MODEL || 'grok-4',

  /**
   * Image generation (Gemini). Unset means the Images panel offers file import
   * only — the same graceful degradation ASR has without ELEVENLABS_API_KEY,
   * rather than a button that fails when pressed.
   *
   * A getter, not a captured value, for the reason the ElevenLabs key is one:
   * the dashboard writes process.env at runtime, and a key set there has to win
   * over what was in the environment at boot. The baked fallback is the same
   * arrangement too (see desktop/android/build.mjs) — it exists so a shipped
   * build can generate before anyone opens the dashboard, and it always loses to
   * a key set there. It matters most on Android, which has no .env and no shell:
   * the dashboard is the ONLY way to set a key on a phone.
   */
  get geminiApiKey() {
    return process.env.GEMINI_API_KEY || process.env.__BAKED_GEMINI_KEY__ || '';
  },

  /**
   * The AI assistant, Claude branch — served through the Claude Agent SDK, not a
   * plain HTTP proxy like Grok. It authenticates two ways, in this order:
   *
   *   1. CLAUDE_CODE_OAUTH_TOKEN — a one-year token minted by `claude setup-token`
   *      that draws on the user's Claude Pro/Max SUBSCRIPTION (no per-token bill).
   *      This is the intended path for the desktop app: run setup-token once, drop
   *      the token in the env, and the agent runs on the plan you already pay for.
   *   2. ANTHROPIC_API_KEY — a Console key billed per token. The fallback for CI or
   *      anyone without a subscription.
   *
   * The SDK reads whichever env var is set on its own, so we don't pass the token
   * around — we only need to KNOW one exists to light up the picker (hasClaude()).
   * CLAUDE_MODEL only sets the default; the user picks per session in the panel.
   */
  get claudeOauthToken() {
    return process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  },
  get claudeApiKey() {
    return process.env.ANTHROPIC_API_KEY ?? '';
  },
  claudeModel: process.env.CLAUDE_MODEL || 'claude-haiku-4-5',

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
    return (Boolean(this.elevenLabsKey) || Boolean(this.sarvamApiKey)) && process.env.ASR_PROVIDER !== 'mock';
  },

  hasElevenLabsAsr(): boolean {
    return Boolean(this.elevenLabsKey) && process.env.ASR_PROVIDER !== 'mock';
  },

  hasSarvamAsr(): boolean {
    return Boolean(this.sarvamApiKey) && process.env.ASR_PROVIDER !== 'mock';
  },

  /** Whether the Grok assistant is configured — it needs an xAI key and nothing else. */
  hasAgent(): boolean {
    return Boolean(this.xaiKey);
  },

  /** Whether the Claude assistant is configured — a subscription token or an API key. */
  hasClaude(): boolean {
    return Boolean(this.claudeOauthToken || this.claudeApiKey);
  },

  /** Whether EITHER assistant backend is available (gates the chat panel at all). */
  hasAnyAgent(): boolean {
    return this.hasAgent() || this.hasClaude();
  },

  /**
   * Whether image inserts can be GENERATED. Importing a file never needs this —
   * without a key the Images panel keeps working, it just cannot make anything.
   */
  hasImageGen(): boolean {
    return Boolean(this.geminiApiKey);
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
   * Cap on an upload. Unlimited by default; set MAX_UPLOAD_MB to impose one.
   * Note the import route buffers the entire file in memory before it touches
   * disk, so an unbounded upload is an unbounded allocation — a very large file
   * can OOM the container. Set MAX_UPLOAD_MB in constrained environments.
   */
  maxUploadBytes: process.env.MAX_UPLOAD_MB
    ? Number(process.env.MAX_UPLOAD_MB) * 1024 * 1024
    : Infinity,

  /**
   * The assistant's licence to improvise — fetch media off the open web and run
   * ffmpeg operations the app has no feature for. See summon.ts, which argues
   * for why those two powers are worth having and how they are bounded.
   *
   * On by default: an assistant that answers "the app can't do that" to every
   * request outside its tool list is the thing this feature exists to avoid.
   * SUMMON=off removes the routes for anyone who would rather it could not.
   */
  summonEnabled: (process.env.SUMMON ?? 'on').toLowerCase() !== 'off',
  /** Cap on ONE fetched file. Separate from maxUploadBytes — see fetchToUploads. */
  summonMaxBytes: (Number(process.env.SUMMON_MAX_MB) || 256) * 1024 * 1024,
  /**
   * Wall clock one summoned ffmpeg operation may burn.
   *
   * Two minutes is a desktop number. A phone encoding H.264 in software is
   * roughly an order of magnitude slower, so the Android shell raises this
   * (NodeRuntime.kt) rather than letting every on-device operation die at the
   * same cap a laptop never reaches.
   */
  summonOpTimeoutMs: (Number(process.env.SUMMON_OP_TIMEOUT_S) || 120) * 1000,
};

/** Defaults for the Cuts panel. The user can change every one of these. */
export const EDIT_DEFAULTS = {
  padMs: 40,
  fadeMs: 12,
  mergeWithinMs: 20,
  maxGapMs: Infinity,
};
