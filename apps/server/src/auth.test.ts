import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  COOKIE,
  authorize,
  cookieHeader,
  cookieValue,
  isGuarded,
  isLoopbackHost,
  tokensMatch,
} from './auth.ts';

const T = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const on = { enabled: true, autoIssue: false };
const loopback = { enabled: true, autoIssue: true };

const req = (over: Partial<Parameters<typeof authorize>[0]> = {}) => ({
  path: '/api/projects',
  authorization: null,
  cookie: null,
  query: null,
  ...over,
});

test('what is guarded, and what deliberately is not', () => {
  assert.equal(isGuarded('/api/projects'), true);
  assert.equal(isGuarded('/media/projects/abc.json'), true, 'the transcript leak lived here');
  assert.equal(isGuarded('/media/uploads/source.mp4'), true);

  // Polled by the desktop shell's waitForServer() and by Docker's HEALTHCHECK,
  // both of which run before they could know a token.
  assert.equal(isGuarded('/api/health'), false);

  // The app shell: the browser must load the page before it can present anything.
  assert.equal(isGuarded('/'), false);
  assert.equal(isGuarded('/assets/index-abc123.js'), false);
});

test('a bearer token is accepted', () => {
  assert.deepEqual(authorize(req({ authorization: `Bearer ${T}` }), T, on), { ok: true });
  assert.deepEqual(authorize(req({ authorization: `bearer ${T}` }), T, on), { ok: true });
});

test('a cookie is accepted — the only thing that works for <video src>', () => {
  assert.deepEqual(authorize(req({ cookie: `${COOKIE}=${T}` }), T, on), { ok: true });
  assert.deepEqual(
    authorize(req({ path: '/media/uploads/a.mp4', cookie: `other=1; ${COOKIE}=${T}; x=2` }), T, on),
    { ok: true },
  );
});

test('no credential on a guarded path is a 401', () => {
  const v = authorize(req(), T, on);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.status, 401);
  assert.equal(v.clearCookie, false, 'nothing to clear when nothing was sent');
});

test('a WRONG cookie is cleared, because otherwise it 401s forever', () => {
  // Cookies ignore port, so a token from a previous install or from the dev
  // server on another port is sent to a server that never issued it. Without
  // clearing, every request fails and the app just looks broken.
  const v = authorize(req({ cookie: `${COOKIE}=${OTHER}` }), T, on);
  assert.equal(v.ok, false);
  if (v.ok) return;
  assert.equal(v.clearCookie, true);
  assert.match(v.message, /reload/i);
});

test('a wrong bearer is refused and does not fall through to the cookie path', () => {
  const v = authorize(req({ authorization: `Bearer ${OTHER}` }), T, on);
  assert.equal(v.ok, false);
});

test('?token= trades a URL for a cookie, then redirects it out of the address bar', () => {
  const v = authorize(req({ path: '/', query: T }), T, on);
  assert.equal(v.ok, true);
  assert.equal((v as { issue: string }).issue, T);
  assert.equal((v as { redirect: string }).redirect, '/');
});

test('a wrong ?token= does not issue anything', () => {
  const v = authorize(req({ path: '/', query: OTHER }), T, on);
  assert.equal(v.ok, true, 'the shell itself is not guarded');
  assert.equal('issue' in v, false, 'but no credential is handed out');
});

test('on loopback the shell hands out the cookie unasked', () => {
  const v = authorize(req({ path: '/' }), T, loopback);
  assert.equal(v.ok, true);
  assert.equal((v as { issue: string }).issue, T);
});

test('off loopback it does NOT — that would be a formality, not authentication', () => {
  const v = authorize(req({ path: '/' }), T, on);
  assert.equal(v.ok, true);
  assert.equal('issue' in v, false);
});

test('auto-issue does not re-issue to someone who already holds the token', () => {
  const v = authorize(req({ path: '/', cookie: `${COOKIE}=${T}` }), T, loopback);
  assert.deepEqual(v, { ok: true });
});

test('AUTH=off lets everything through, for anyone fronting this themselves', () => {
  assert.deepEqual(authorize(req(), T, { enabled: false, autoIssue: false }), { ok: true });
});

test('cookieValue tolerates the shapes browsers actually send', () => {
  assert.equal(cookieValue(null, COOKIE), null);
  assert.equal(cookieValue('', COOKIE), null);
  assert.equal(cookieValue(`${COOKIE}=x`, COOKIE), 'x');
  assert.equal(cookieValue(` a=1 ;  ${COOKIE}=x ; b=2`, COOKIE), 'x');
  assert.equal(cookieValue('nope=1', COOKIE), null);
  assert.equal(cookieValue('malformed', COOKIE), null);
});

test('tokensMatch is total — a length mismatch must not throw', () => {
  // timingSafeEqual throws on unequal lengths, and an attacker controls the
  // length, so the guard is not cosmetic: without it every short token is a 500.
  assert.equal(tokensMatch('short', T), false);
  assert.equal(tokensMatch('', T), false);
  assert.equal(tokensMatch(T, ''), false);
  assert.equal(tokensMatch(T, T), true);
});

test('the cookie is HttpOnly and SameSite=Strict — the CSRF defence itself', () => {
  const h = cookieHeader(T);
  assert.match(h, /HttpOnly/);
  assert.match(h, /SameSite=Strict/);
  assert.match(h, /Path=\//);
  assert.match(cookieHeader('', 0), /Max-Age=0/, 'clearing must expire it');
});

test('isLoopbackHost knows which binds are this-machine-only', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('localhost'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost('192.168.0.134'), false);
});
