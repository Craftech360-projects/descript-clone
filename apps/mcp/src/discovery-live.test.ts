import { test } from 'node:test';
import assert from 'node:assert/strict';

import { looksAlive, pickBridge, type Bridge } from './discovery.ts';

/**
 * Two bridge files, one dead — which one wins.
 *
 * Not hypothetical: the installed app keeps its bridge in Application Support and
 * a repo checkout keeps one in ./data, so anyone doing both has two. Returning
 * the first READABLE one meant a stale entry from an app that exited days ago
 * shadowed a server running right now, and every tool reported "not running"
 * while the editor sat there open.
 *
 * Tested through the pure chooser rather than read(), because read() also
 * searches real paths — Application Support, the repo — and a test that asserts
 * against those passes or fails depending on what happens to be installed on the
 * machine running it. (It did: an early version of this file picked up the
 * author's own running app.)
 */

const DEAD = 4_194_303; // above every default pid_max, so nothing to signal

const bridge = (port: number, pid: number): Bridge => ({
  enabled: true, host: '127.0.0.1', port, mode: 'server',
  appPath: null, logPath: null, pid, startedAt: '', token: 't',
});

test('a live bridge beats a stale one that comes first', () => {
  const picked = pickBridge([bridge(1111, DEAD), bridge(2222, process.pid)]);
  assert.equal(picked?.port, 2222);
});

test('order still decides between two live ones', () => {
  const picked = pickBridge([bridge(1111, process.pid), bridge(2222, process.pid)]);
  assert.equal(picked?.port, 1111, 'the more specific search path wins');
});

test('with nothing alive, the first is returned anyway', () => {
  // So editor_status reports "last seen on port 1111" instead of "no bridge file".
  const picked = pickBridge([bridge(1111, DEAD), bridge(3333, DEAD)]);
  assert.equal(picked?.port, 1111);
  assert.equal(looksAlive(picked), false, 'and is correctly reported as not alive');
});

test('nothing found is null, not a throw', () => {
  assert.equal(pickBridge([]), null);
});

test('a retired bridge (port 0) never counts as alive', () => {
  const retired = bridge(0, 0);
  assert.equal(looksAlive(retired), false);
  assert.equal(pickBridge([retired, bridge(2222, process.pid)])?.port, 2222);
});
