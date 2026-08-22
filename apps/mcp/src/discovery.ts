import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Finding the running editor, every time rather than once.
 *
 * The desktop app takes a fresh port each launch and the agent restarts the app
 * whenever it changes code, so anything cached here would be stale within
 * minutes. `read()` therefore hits the file on every call. It is a small local
 * JSON read; the alternative is an agent that is confidently wrong about where
 * the app is.
 *
 * Search order, most specific first:
 *   JUMPCUT_BRIDGE   an explicit path to bridge.json
 *   JUMPCUT_DATA_DIR the data directory holding it
 *   the packaged app's Application Support directory
 *   the repo's own data/ directory (development)
 */

export interface Bridge {
  enabled: boolean;
  host: string;
  port: number;
  mode: string;
  appPath: string | null;
  logPath: string | null;
  pid: number;
  startedAt: string;
  token: string;
}

/** Where the Mac app keeps its per-user state. Mirrors Electron's app.getPath('userData'). */
const APP_SUPPORT = join(homedir(), 'Library', 'Application Support', 'Transcript Editor');

export function candidatePaths(): string[] {
  const out: string[] = [];
  if (process.env.JUMPCUT_BRIDGE) out.push(process.env.JUMPCUT_BRIDGE);
  if (process.env.JUMPCUT_DATA_DIR) out.push(join(process.env.JUMPCUT_DATA_DIR, 'bridge.json'));
  out.push(join(APP_SUPPORT, 'data', 'bridge.json'));
  // ../../../data/ from apps/mcp/src — the repo checkout, for development.
  out.push(fileURLToPath(new URL('../../../data/bridge.json', import.meta.url)));
  return out;
}

export async function read(): Promise<Bridge | null> {
  for (const path of candidatePaths()) {
    try {
      const d = JSON.parse(await readFile(path, 'utf8')) as Partial<Bridge>;
      if (typeof d.port === 'number' && typeof d.token === 'string') {
        return {
          enabled: d.enabled === true,
          host: d.host ?? '127.0.0.1',
          port: d.port,
          mode: d.mode ?? 'server',
          appPath: d.appPath ?? null,
          logPath: d.logPath ?? null,
          pid: d.pid ?? 0,
          startedAt: d.startedAt ?? '',
          token: d.token,
        };
      }
    } catch {
      // Not here, or unreadable. Try the next.
    }
  }
  return null;
}

/**
 * The base URL to call.
 *
 * JUMPCUT_URL overrides everything, for a Hermes running somewhere the file is
 * not — but note the token still has to come from somewhere, so JUMPCUT_TOKEN
 * goes with it.
 */
export function baseUrl(b: Bridge): string {
  if (process.env.JUMPCUT_URL) return process.env.JUMPCUT_URL.replace(/\/$/, '');
  const host = b.host === '::' || b.host === '0.0.0.0' ? '127.0.0.1' : b.host;
  return `http://${host}:${b.port}`;
}

export function token(b: Bridge | null): string {
  return process.env.JUMPCUT_TOKEN || b?.token || '';
}

/** A port of 0 means the app retired cleanly; a pid we cannot signal means it died. */
export function looksAlive(b: Bridge | null): boolean {
  if (!b || !b.port) return false;
  if (!b.pid) return true; // No pid recorded — let the HTTP probe decide.
  try {
    // Signal 0 tests for existence without delivering anything.
    process.kill(b.pid, 0);
    return true;
  } catch {
    return false;
  }
}
