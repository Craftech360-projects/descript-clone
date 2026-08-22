import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * bridge.json — how an outside agent finds a server whose port it cannot predict.
 *
 * The desktop shell asks the OS for a free port every launch, which is right (this
 * machine runs a dev server and the packaged app side by side) and means a URL in
 * a config file is wrong by the second launch. Publishing the real port, and
 * reading it at call time, is what decouples the agent's lifetime from the app's.
 */

const data = await mkdtemp(join(tmpdir(), 'jumpcut-bridge-'));
process.env.DATA_DIR = data;
process.env.JUMPCUT_TOKEN = 'f'.repeat(64);

const bridge = await import('./bridge.ts');
const auth = await import('./auth.ts');
await auth.init();

const file = join(data, 'bridge.json');
const read = async () => JSON.parse(await readFile(file, 'utf8'));

test('the bridge is OFF until somebody turns it on', async () => {
  await bridge.init();
  assert.equal(bridge.enabled(), false);
});

test('publish records the port that was actually bound', async () => {
  await bridge.publish(54321);
  const d = await read();
  assert.equal(d.port, 54321);
  assert.equal(d.pid, process.pid);
  assert.ok(d.startedAt, 'and when, so a stale file is recognisable');
});

test('the file carries the token, at 0600 — it is a credential', async () => {
  await bridge.publish(54321);
  const d = await read();
  assert.equal(d.token, 'f'.repeat(64));
  const mode = (await stat(file)).mode & 0o777;
  assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`);
});

test('enabling survives a restart, but the port does not', async () => {
  await bridge.setEnabled(true);
  await bridge.publish(54321);

  // A fresh init() is what a restart looks like.
  await bridge.init();
  assert.equal(bridge.enabled(), true, 'the choice is the user’s and persists');
  assert.equal(bridge.state().port, 0, 'a port from a dead process must not read as current');
});

test('url() reports 127.0.0.1 rather than localhost', async () => {
  // On a machine where localhost resolves to ::1 first, a server bound to IPv4
  // refuses the connection — and "connection refused to the address you gave me"
  // is a miserable thing to debug.
  await bridge.publish(8788);
  assert.equal(bridge.url(), 'http://127.0.0.1:8788');
});

test('a wildcard bind is still reported as a reachable loopback address', async () => {
  const { CONFIG } = await import('./config.ts');
  const original = CONFIG.host;
  Object.defineProperty(CONFIG, 'host', { value: '0.0.0.0', configurable: true });
  await bridge.publish(9000);
  assert.equal(bridge.url(), 'http://127.0.0.1:9000', '0.0.0.0 is not somewhere you can connect to');
  Object.defineProperty(CONFIG, 'host', { value: original, configurable: true });
});

test('retire clears the live fields so a dead app is obvious', async () => {
  await bridge.publish(8788);
  await bridge.retire();
  const d = await read();
  assert.equal(d.port, 0);
  assert.equal(d.pid, 0);
  assert.equal(d.enabled, true, 'but the preference is not forgotten');
});
