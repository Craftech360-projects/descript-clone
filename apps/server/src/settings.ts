import type { Hono } from 'hono';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { CONFIG } from './config.ts';

/**
 * Runtime-editable API keys — set from the dashboard, no restart, no .env edit.
 *
 * The mechanism is deliberately small: every managed key IS an environment
 * variable, and the one thing this module does is keep `process.env` and a small
 * on-disk file in agreement. On boot it loads the file into `process.env`; a save
 * writes both. That is enough to make both assistant backends live-editable —
 * CONFIG reads these env vars through getters (config.ts), and the Claude Agent
 * SDK reads `process.env` directly — so neither captures a stale value.
 *
 * ⚠️ Two honest limitations, stated here and in the UI:
 *   1. Anyone holding the app's token can change these keys. That used to read
 *      "this API is unauthenticated", which it no longer is (auth.ts) — but the
 *      token is a single shared credential with no scopes, so a caller who can
 *      list projects can also rewrite every key. Treat holding it as holding the
 *      keys, because it is.
 *   2. Keys are stored in PLAINTEXT on disk, exactly as a .env file would be. The
 *      file lives OUTSIDE the media directory, so it is never served over /media.
 */

interface ManagedKey {
  /** Stable id used on the wire and in the UI. */
  id: string;
  /** The environment variable this key backs. */
  env: string;
  label: string;
  hint: string;
}

/**
 * The keys the dashboard can manage. Adding one here is all it takes to expose it.
 *
 * On the phone this list is not a convenience — it is the ONLY way a key can be
 * set. Android has no .env to edit and no shell to export from, so a credential
 * missing from here is a feature that can never be switched on from the device.
 * That is why GEMINI_API_KEY is on it: image generation is otherwise dark on
 * every build that did not bake a key in at compile time.
 */
export const MANAGED_KEYS: ManagedKey[] = [
  { id: 'xai', env: 'XAI_API_KEY', label: 'xAI API key', hint: 'Grok assistant — console.x.ai' },
  { id: 'anthropic', env: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', hint: 'Claude assistant, per-token billing' },
  { id: 'claudeOauth', env: 'CLAUDE_CODE_OAUTH_TOKEN', label: 'Claude subscription token', hint: 'From `claude setup-token` — uses your Claude plan' },
  { id: 'elevenlabs', env: 'ELEVENLABS_API_KEY', label: 'ElevenLabs API key', hint: 'Transcription (Scribe)' },
  { id: 'sarvam', env: 'SARVAM_API_KEY', label: 'Sarvam API key', hint: 'Transcription (Saaras v3)' },
  { id: 'gemini', env: 'GEMINI_API_KEY', label: 'Gemini API key', hint: 'Generating image inserts — aistudio.google.com' },
  { id: 'jamendo', env: 'JAMENDO_CLIENT_ID', label: 'Jamendo client ID', hint: 'Larger background-music catalogue (optional)' },
];

const byId = new Map(MANAGED_KEYS.map((k) => [k.id, k]));

/**
 * Where the persisted keys live: the repo root, NOT the media directory (which is
 * served statically at /media, so a secrets file there would be downloadable).
 *
 * That default is computed relative to THIS file, which is only correct in dev.
 * Bundled into one file for the desktop build (see desktop/mac/build.mjs and
 * desktop/win/build.mjs), the same relative path resolves outside the
 * installed app instead — e.g. /Applications on Mac, C:\ on Windows — usually
 * unwritable and always wrong. The desktop main process sets SETTINGS_PATH to
 * Electron's per-user userData dir (see desktop/mac/main.cjs and
 * desktop/win/main.cjs) precisely to override this.
 */
const SETTINGS_PATH =
  process.env.SETTINGS_PATH || fileURLToPath(new URL('../../../.jumpcut-secrets.json', import.meta.url));

/** Load persisted keys into process.env. Missing file is the normal first-run case. */
export async function init(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(SETTINGS_PATH, 'utf8');
  } catch {
    return; // no file yet — env (from .env) stands on its own
  }
  try {
    const stored = JSON.parse(raw) as Record<string, unknown>;
    for (const key of MANAGED_KEYS) {
      const value = stored[key.env];
      // A value in the file is authoritative — the dashboard is where the user
      // last decided this — so it overrides whatever .env loaded at boot.
      if (typeof value === 'string' && value) process.env[key.env] = value;
    }
  } catch {
    // A corrupt file must not take the server down; leave env as it was.
  }
}

/** The masked, safe-to-return view: whether each key is set, and a tail hint only. */
function status(): Record<string, { configured: boolean; hint: string; label: string; note: string }> {
  const out: Record<string, { configured: boolean; hint: string; label: string; note: string }> = {};
  for (const key of MANAGED_KEYS) {
    const value = process.env[key.env] ?? '';
    out[key.id] = {
      configured: Boolean(value),
      // Never the secret — just enough to recognise which key is in place.
      hint: value ? (value.length > 4 ? `…${value.slice(-4)}` : '••••') : '',
      label: key.label,
      note: key.hint,
    };
  }
  return out;
}

/** Persist the current values of every managed key to disk (plaintext, 0600). */
async function persist(): Promise<void> {
  const stored: Record<string, string> = {};
  for (const key of MANAGED_KEYS) {
    const value = process.env[key.env];
    if (value) stored[key.env] = value;
  }
  await writeFile(SETTINGS_PATH, JSON.stringify(stored, null, 2), { mode: 0o600 });
}

export function registerSettings(app: Hono): void {
  /** Current key status (masked) plus which backends that lights up. */
  app.get('/api/settings/keys', (c) =>
    c.json({
      keys: status(),
      backends: backends(),
    }),
  );

  /**
   * Set or clear keys. Body: { <id>: string }. A non-empty string sets that key,
   * an empty string (or null) clears it. Only whitelisted ids are honoured, so a
   * stray field cannot write an arbitrary environment variable.
   */
  app.post('/api/settings/keys', async (c) => {
    const body = await c.req.json<Record<string, unknown>>().catch(() => ({}));
    let touched = 0;
    for (const [id, value] of Object.entries(body)) {
      const key = byId.get(id);
      if (!key) continue; // ignore unknown ids — never write outside the whitelist
      if (typeof value === 'string' && value.trim()) {
        process.env[key.env] = value.trim();
        touched++;
      } else if (value === '' || value === null) {
        delete process.env[key.env];
        touched++;
      }
    }
    if (touched > 0) {
      try {
        await persist();
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : 'Could not save keys to disk.' }, 500);
      }
    }
    return c.json({ keys: status(), backends: backends() });
  });
}

/**
 * What the keys currently light up, which is not the same question as which keys
 * are set: a build can bake a fallback in (see desktop/android/build.mjs), so a
 * capability can be ON while its row honestly reads "not set". This is the line
 * that tells the truth about what will work.
 */
function backends() {
  return {
    grok: CONFIG.hasAgent(),
    claude: CONFIG.hasClaude(),
    asr: CONFIG.hasAsr(),
    images: CONFIG.hasImageGen(),
  };
}
