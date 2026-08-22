import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { CONFIG } from './config.ts';

/**
 * One shared token in front of the API and the media directory.
 *
 * ── what this is defending against ──────────────────────────────────────────
 *
 * Now that the server binds 127.0.0.1 by default (see config.ts `host`), the
 * network is no longer the threat. Two local ones remain, and they need
 * different answers:
 *
 *   1. A web page the user happens to have open. Any site can fetch
 *      http://127.0.0.1:8787/api/settings/keys and rewrite every credential this
 *      app holds — loopback is not a security boundary inside a browser. The
 *      answer is a SameSite=Strict cookie: a request originating from evil.com
 *      is cross-site, so the cookie is never attached, so it gets a 401.
 *
 *   2. Another user or process on the same machine. The answer is the token
 *      file at mode 0600 — the same trust boundary .jumpcut-secrets.json
 *      already relies on.
 *
 * ── why a cookie and not just a bearer header ───────────────────────────────
 *
 * A bearer header cannot travel on <video src="/media/uploads/…">, on a poster
 * <img>, on @font-face, or on the render download that the desktop shell
 * intercepts with a Save dialog. Those are plain browser-issued GETs with no
 * JavaScript in the loop. If /media is to be protected at all — and it holds the
 * source footage — it has to be a cookie. The pleasant side effect is that none
 * of the 34 existing fetch() call sites had to change.
 *
 * ── the three ways to present it ────────────────────────────────────────────
 *
 *   Authorization: Bearer <token>   Hermes, curl, the MCP servers. Inherently
 *                                   CSRF-immune: a cross-origin page cannot set
 *                                   a custom header on a simple request, and it
 *                                   does not know the value anyway.
 *   Cookie jumpcut_token            The browser and the Electron renderer.
 *   ?token=<token> on GET /         The bootstrap for a remote deployment: sets
 *                                   the cookie, then redirects to / so the token
 *                                   does not sit in the address bar or in
 *                                   history. Jupyter's pattern.
 *
 * ── auto-issue, and why it is safe on loopback only ─────────────────────────
 *
 * When the server is bound to loopback, GET / hands out the cookie unasked. That
 * is not a hole: reaching that route already required being on this machine,
 * which is the boundary the token is not trying to enforce. It buys a browser
 * user zero friction, and SameSite=Strict still means a page on evil.com can
 * never get the cookie SENT even though it could technically cause one to be
 * set.
 *
 * When HOST is something else, auto-issue is OFF — otherwise anyone who could
 * reach the port would simply load / and be handed the key, which is not
 * authentication, it is a formality.
 */

export const COOKIE = 'jumpcut_token';

/** Token file lives with the other private state, never under mediaDir. */
const tokenFile = () => join(CONFIG.dataDir, 'token');

let token = '';

/** Is this bind address one only this machine can reach? */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/** Auth can be turned off for anyone fronting this with their own. Default on. */
export function authEnabled(): boolean {
  return (process.env.AUTH ?? '').toLowerCase() !== 'off';
}

export function currentToken(): string {
  return token;
}

/**
 * Load the token, minting one on first boot.
 *
 * Stable across restarts on purpose: a token that rotated every boot would
 * invalidate Hermes's cached credential and every open browser tab each time the
 * agent restarted the server — which, given the agent restarts the server on
 * every code change, is constantly.
 */
export async function init(): Promise<void> {
  if (process.env.JUMPCUT_TOKEN) {
    token = process.env.JUMPCUT_TOKEN;
    return;
  }

  try {
    const saved = (await readFile(tokenFile(), 'utf8')).trim();
    if (saved) {
      token = saved;
      return;
    }
  } catch {
    // First boot. Mint one below.
  }

  token = randomBytes(32).toString('hex');
  await mkdir(dirname(tokenFile()), { recursive: true }).catch(() => {});
  await writeFile(tokenFile(), token, { mode: 0o600 });
  await chmod(tokenFile(), 0o600).catch(() => {});
}

/** Replace the token — the Settings panel's Regenerate button. */
export async function rotate(): Promise<string> {
  token = randomBytes(32).toString('hex');
  await mkdir(dirname(tokenFile()), { recursive: true }).catch(() => {});
  await writeFile(tokenFile(), token, { mode: 0o600 });
  await chmod(tokenFile(), 0o600).catch(() => {});
  return token;
}

/**
 * Does this path need a credential?
 *
 * /api and /media do. The app shell does NOT — the browser has to be able to
 * load the page before it can present anything, and the HTML is a build artefact
 * with nothing private in it.
 *
 * GET /api/health is exempt because both the desktop shell's waitForServer() and
 * the Docker HEALTHCHECK poll it before they could possibly know a token, and it
 * reports only whether ffmpeg is present.
 */
export function isGuarded(path: string): boolean {
  if (path === '/api/health') return false;
  return path.startsWith('/api') || path.startsWith('/media');
}

/** Pull a cookie value out of a raw Cookie header. */
export function cookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return null;
}

/** Constant-time compare that tolerates length mismatch without throwing. */
export function tokensMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

export interface AuthRequest {
  path: string;
  /** The Authorization header, verbatim. */
  authorization: string | null;
  /** The raw Cookie header. */
  cookie: string | null;
  /** The `token` query parameter, if present. */
  query: string | null;
}

export type AuthVerdict =
  | { ok: true }
  /** Credential accepted from a query string — set the cookie and redirect. */
  | { ok: true; issue: string; redirect: string }
  /** No credential needed, and we are handing one out (loopback shell load). */
  | { ok: true; issue: string }
  | { ok: false; status: 401; message: string; clearCookie: boolean };

export interface AuthOptions {
  enabled: boolean;
  /** True when the bind address means "this machine only". */
  autoIssue: boolean;
}

/**
 * Decide what to do with one request. Pure — no Hono, no I/O, no globals.
 *
 * Kept separate from the middleware so it can be tested exhaustively without a
 * live server, which is this codebase's habit: packages/core is pure and covered,
 * and the I/O sits in a thin wrapper at the edge.
 */
export function authorize(req: AuthRequest, token: string, opts: AuthOptions): AuthVerdict {
  const guarded = isGuarded(req.path);

  if (!opts.enabled) return { ok: true };

  // The bootstrap: ?token= on any unguarded path (in practice the app shell).
  // Accepted before the guard check so a fresh browser can trade a URL for a
  // cookie in one navigation.
  if (req.query && tokensMatch(req.query, token)) {
    return { ok: true, issue: token, redirect: req.path };
  }

  if (!guarded) {
    // The app shell. Hand out the cookie when only this machine could have asked.
    const has = cookieValue(req.cookie, COOKIE);
    if (opts.autoIssue && !tokensMatch(has ?? '', token)) return { ok: true, issue: token };
    return { ok: true };
  }

  const bearer = /^Bearer\s+(.+)$/i.exec(req.authorization ?? '')?.[1]?.trim() ?? '';
  if (tokensMatch(bearer, token)) return { ok: true };

  const cookie = cookieValue(req.cookie, COOKIE);
  if (cookie && tokensMatch(cookie, token)) return { ok: true };

  /**
   * A WRONG cookie is a different situation from no cookie, and it is the one
   * that produces a mystifying bug report.
   *
   * Cookies ignore port, so a token left over from a previous install — or from
   * the dev server on 8787 while the packaged app runs on 8788 — is sent to a
   * server that has never seen it. Every request 401s and the app looks broken
   * with no clue why. Clearing it turns an infinite failure into one bad reload.
   */
  return {
    ok: false,
    status: 401,
    message: cookie
      ? 'This editor did not issue that token. The stale one has been cleared — reload the page.'
      : 'This editor needs its token. Open it from the address the server printed on startup.',
    clearCookie: Boolean(cookie),
  };
}

/** The Set-Cookie value. Strict, HttpOnly, and never Secure — this is http://localhost. */
export function cookieHeader(value: string, maxAgeSeconds?: number): string {
  const age = maxAgeSeconds === undefined ? '' : `; Max-Age=${maxAgeSeconds}`;
  // SameSite=Strict is the entire CSRF defence — see the header comment.
  // HttpOnly means page JavaScript cannot read it, so an XSS in the editor
  // cannot hand the token to anyone.
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict${age}`;
}
