import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG } from './config.ts';
import * as auth from './auth.ts';

/**
 * How an outside agent finds this editor, and whether it is allowed to drive it.
 *
 * ── the discovery problem, which is the real reason this file exists ────────
 *
 * The desktop app asks the OS for a FREE port (desktop/mac/main.cjs `freePort`)
 * and gets a different one every launch. That is the right behaviour and worth
 * keeping — this machine runs a dev server and the packaged app side by side, and
 * a fixed port guarantees a collision between them. But it means an MCP server
 * configured with a URL would be wrong by the second launch.
 *
 * So the server publishes where it actually landed. `bridge.json` is written from
 * inside the serve() callback, where `info.port` is the port that was really
 * bound, and the MCP process reads it AT TOOL-CALL TIME rather than at startup —
 * which is what makes an app restart on a new port invisible to Hermes. The
 * agent restarts the app every time it changes code, so this is not a rare case.
 *
 * The Hermes-side config therefore names a COMMAND and never a port.
 *
 * ── the toggle ─────────────────────────────────────────────────────────────
 *
 * Off by default. `enabled` is not decoration: /api/bridge/* returns 403 while it
 * is false, so the switch in Settings genuinely withholds the capability rather
 * than merely hiding a panel. Turning it on hands an outside process every
 * control the app has, which is a decision that should be made once, on purpose.
 *
 * Lives in dataDir at 0600, like preferences and the token — never mediaDir,
 * which is served at /media.
 */

export interface BridgeState {
  /** May an outside agent drive this editor? Off until someone says otherwise. */
  enabled: boolean;
  /** Where the server actually bound, refreshed every boot. */
  host: string;
  port: number;
  /** 'desktop' when an Electron shell started us, 'server' otherwise. */
  mode: string;
  /** The app bundle to relaunch, when the shell told us. */
  appPath: string | null;
  /** Where the server's output goes, so an agent can read its own crash. */
  logPath: string | null;
  pid: number;
  startedAt: string;
}

const file = () => join(CONFIG.dataDir, 'bridge.json');

const DEFAULTS: BridgeState = {
  enabled: false,
  host: '127.0.0.1',
  port: 0,
  mode: 'server',
  appPath: null,
  logPath: null,
  pid: 0,
  startedAt: '',
};

let cache: BridgeState = { ...DEFAULTS };

export async function init(): Promise<void> {
  try {
    const raw = JSON.parse(await readFile(file(), 'utf8')) as Partial<BridgeState>;
    // Only `enabled` carries across a restart. Everything else describes THIS
    // process, and a stale port read as current is worse than no file at all.
    cache = { ...DEFAULTS, enabled: raw.enabled === true };
  } catch {
    cache = { ...DEFAULTS };
  }
}

/** Called once the real port is known. See the header. */
export async function publish(port: number): Promise<void> {
  cache = {
    ...cache,
    host: CONFIG.host,
    port,
    mode: process.env.JUMPCUT_SHELL || 'server',
    appPath: process.env.JUMPCUT_APP_PATH || null,
    logPath: process.env.JUMPCUT_LOG_PATH || null,
    pid: process.pid,
    startedAt: new Date().toISOString(),
  };
  await flush();
}

export function state(): BridgeState {
  return { ...cache };
}

export function enabled(): boolean {
  return cache.enabled;
}

export async function setEnabled(on: boolean): Promise<BridgeState> {
  cache = { ...cache, enabled: on };
  await flush();
  return state();
}

/**
 * The URL an outside caller should use.
 *
 * Loopback is reported as 127.0.0.1 rather than localhost deliberately: on a
 * machine where localhost resolves to ::1 first, a server bound to IPv4 refuses
 * the connection, and "connection refused to the address you told me" is a
 * miserable thing to debug.
 */
export function url(): string {
  const host = cache.host === '::' || cache.host === '0.0.0.0' ? '127.0.0.1' : cache.host;
  return `http://${host}:${cache.port}`;
}

async function flush(): Promise<void> {
  const target = file();
  const tmp = `${target}.tmp`;
  await mkdir(CONFIG.dataDir, { recursive: true }).catch(() => {});
  // The token is in here, so 0600 for the same reason the token file itself is.
  await writeFile(tmp, JSON.stringify({ ...cache, token: auth.currentToken() }, null, 2), { mode: 0o600 });
  await rename(tmp, target);
}

/**
 * Clear the live fields on a clean exit, so a stale file is recognisable.
 *
 * Without this, `wake_editor` reads a port from a dead process, tries it, and has
 * to wait for a connection to fail before concluding the app is not running —
 * when the file could simply have said so.
 */
export async function retire(): Promise<void> {
  cache = { ...cache, port: 0, pid: 0 };
  await flush().catch(() => {});
  await unlink(`${file()}.tmp`).catch(() => {});
}
