import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Finding a server whose port changes every launch.
 *
 * The desktop shell takes a free port each time, and the agent restarts the app
 * whenever it edits code — so "where is Jumpstart" has to be answerable fresh on
 * every call, and answerable NEGATIVELY without throwing when the app is down.
 * A discovery layer that raises on a missing file would take the agent's
 * diagnostic tools down with the app, which is the one thing the two-process
 * split exists to prevent.
 */

const dir = await mkdtemp(join(tmpdir(), 'jumpcut-disc-'));
process.env.JUMPSTART_DATA_DIR = dir;
delete process.env.JUMPSTART_BRIDGE;
delete process.env.JUMPSTART_URL;
delete process.env.JUMPSTART_TOKEN;

const d = await import('./discovery.ts');

const write = (patch: Record<string, unknown>) =>
  writeFile(
    join(dir, 'bridge.json'),
    JSON.stringify({ enabled: true, host: '127.0.0.1', port: 8787, pid: process.pid, token: 'a'.repeat(64), ...patch }),
  );

test('a missing bridge file reads as "not running", not as an error', async () => {
  // JUMPSTART_DATA_DIR points at an empty dir, so nothing is found. Both fallback
  // paths (the app bundle, the repo) may or may not exist on a given machine,
  // so assert only that it does not throw.
  await assert.doesNotReject(() => d.read());
});

test('a published bridge is read back whole', async () => {
  await write({ port: 54321 });
  const b = await d.read();
  assert.equal(b?.port, 54321);
  assert.equal(b?.token, 'a'.repeat(64));
  assert.equal(b?.enabled, true);
});

test('the file is re-read every call, so a restart on a new port is invisible', async () => {
  await write({ port: 1111 });
  assert.equal((await d.read())?.port, 1111);
  await write({ port: 2222 });
  assert.equal((await d.read())?.port, 2222, 'a cached value here would strand the agent');
});

test('a truncated file does not take the caller down', async () => {
  await writeFile(join(dir, 'bridge.json'), '{ not json');
  await assert.doesNotReject(() => d.read());
});

test('JUMPSTART_BRIDGE wins over the search path', async () => {
  const other = join(dir, 'elsewhere.json');
  await writeFile(other, JSON.stringify({ port: 9999, token: 'b'.repeat(64) }));
  process.env.JUMPSTART_BRIDGE = other;
  assert.equal((await d.read())?.port, 9999);
  delete process.env.JUMPSTART_BRIDGE;
});

test('baseUrl turns a wildcard bind into something connectable', () => {
  const base = { enabled: true, mode: 'server', appPath: null, logPath: null, pid: 0, startedAt: '', token: 't' };
  assert.equal(d.baseUrl({ ...base, host: '127.0.0.1', port: 8787 }), 'http://127.0.0.1:8787');
  // You cannot connect TO 0.0.0.0; it is an address to listen on.
  assert.equal(d.baseUrl({ ...base, host: '0.0.0.0', port: 8787 }), 'http://127.0.0.1:8787');
  assert.equal(d.baseUrl({ ...base, host: '::', port: 8787 }), 'http://127.0.0.1:8787');
});

test('a retired file (port 0) is not mistaken for a live app', () => {
  const b = { enabled: true, host: '127.0.0.1', port: 0, mode: 'server', appPath: null, logPath: null, pid: 0, startedAt: '', token: 't' };
  assert.equal(d.looksAlive(b), false);
  assert.equal(d.looksAlive(null), false);
});

test('a pid that no longer exists means the app died without retiring', () => {
  const base = { enabled: true, host: '127.0.0.1', port: 8787, mode: 'server', appPath: null, logPath: null, startedAt: '', token: 't' };
  assert.equal(d.looksAlive({ ...base, pid: process.pid }), true);
  // A pid nothing can be signalled at. 2^22 is above every default pid_max.
  assert.equal(d.looksAlive({ ...base, pid: 4_194_303 }), false);
});

test('JUMPSTART_TOKEN overrides the file, for a host that cannot read it', () => {
  process.env.JUMPSTART_TOKEN = 'override';
  assert.equal(d.token(null), 'override');
  delete process.env.JUMPSTART_TOKEN;
});
