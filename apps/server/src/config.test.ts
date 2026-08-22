import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * The bind address, which used to be nobody's decision.
 *
 * `serve()` was called without a hostname, so @hono/node-server's default took
 * over and bound `::` — every interface. An editor started on a laptop was
 * reachable from every machine on the same wifi, with no authentication in front
 * of it, while the startup banner said "http://localhost". Verified before the
 * fix by curling the LAN address from another host: 200.
 *
 * CONFIG is a module-level object evaluated once at import, so the two cases here
 * cannot both be exercised in one process. Each spawns its own node — slower than
 * a unit test and worth it, because the thing under test IS the default.
 */

const configPath = fileURLToPath(new URL('./config.ts', import.meta.url));

function hostWith(env: Record<string, string>): string {
  return execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(configPath)}).then(m => process.stdout.write(m.CONFIG.host))`],
    { env: { ...process.env, HOST: '', ...env }, encoding: 'utf8' },
  ).trim();
}

test('with no HOST set, the server binds loopback only', () => {
  // Delete rather than blank it: '' is falsy but `??` only falls through on
  // nullish, so an empty HOST would bind '' — every interface, silently.
  const env = { ...process.env };
  delete env.HOST;
  const host = execFileSync(
    process.execPath,
    ['-e', `import(${JSON.stringify(configPath)}).then(m => process.stdout.write(m.CONFIG.host))`],
    { env, encoding: 'utf8' },
  ).trim();
  assert.equal(host, '127.0.0.1');
});

test('HOST=0.0.0.0 is honoured, for containers that mean it', () => {
  assert.equal(hostWith({ HOST: '0.0.0.0' }), '0.0.0.0');
});
