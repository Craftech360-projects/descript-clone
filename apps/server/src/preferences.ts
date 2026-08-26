/**
 * Choices that should outlive a page reload, and belong to the INSTALL rather
 * than the browser.
 *
 * The model is the one that prompted this. It was in-memory only, so every
 * reload silently reset it to the server's default — you would pick a model,
 * refresh, and be quietly back on the cheap one without being told. A setting
 * that resets itself is worse than no setting, because you stop trusting the
 * ones that do stick.
 *
 * Why the server and not localStorage: "which model does Jumpy use" is a
 * property of this installation, not of the browser looking at it. Open the app
 * in another window and it should be the same app. Layout widths and the
 * safe-area toggle stay in localStorage, correctly — those really are about the
 * window you are looking through.
 *
 * Lives in dataDir, NOT mediaDir: mediaDir is served at /media, and this file
 * has no business being downloadable. See CONFIG.dataDir.
 */

import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG } from './config.ts';

export interface Preferences {
  /** The model Jumpy uses. A `local:` prefix means an on-device runtime. */
  model: string;
  /** Where social copy is written for by default. */
  socialTarget: string;
  /** Which platform's furniture the monitor outlines. '' is off. */
  safeArea: string;
}

const DEFAULTS: Preferences = { model: '', socialTarget: 'reels', safeArea: '' };

const file = () => join(CONFIG.dataDir, 'preferences.json');

let cache: Preferences | null = null;

export async function init(): Promise<void> {
  await mkdir(CONFIG.dataDir, { recursive: true }).catch(() => {});
  cache = await read();
}

async function read(): Promise<Preferences> {
  try {
    const parsed = JSON.parse(await readFile(file(), 'utf8')) as Partial<Preferences>;
    // Per field, not per object: a preferences file written before a setting
    // existed must pick up the default for that one alone rather than losing the
    // choices it does carry.
    return {
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULTS.model,
      socialTarget: typeof parsed.socialTarget === 'string' ? parsed.socialTarget : DEFAULTS.socialTarget,
      safeArea: typeof parsed.safeArea === 'string' ? parsed.safeArea : DEFAULTS.safeArea,
    };
  } catch {
    // Absent or unreadable both mean "no choices yet". A corrupt preferences
    // file must never stop the app opening — nothing here is worth that.
    return { ...DEFAULTS };
  }
}

export function get(): Preferences {
  return cache ?? { ...DEFAULTS };
}

export async function patch(next: Partial<Preferences>): Promise<Preferences> {
  const merged: Preferences = { ...get(), ...next };
  cache = merged;

  // Temp then rename: a half-written preferences file would read as corrupt on
  // the next start and silently throw away every choice.
  const target = file();
  const tmp = `${target}.tmp`;
  await mkdir(CONFIG.dataDir, { recursive: true }).catch(() => {});
  await writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await rename(tmp, target);
  return merged;
}
