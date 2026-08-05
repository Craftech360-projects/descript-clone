'use strict';

/**
 * Node entry point on Android — the analog of the env block in
 * desktop/win/main.cjs, in JS instead of a spawn's `env:` option.
 *
 * nodejs-mobile runs Node IN-PROCESS: there is no child process whose
 * environment the shell controls. So the Kotlin side writes a JSON config file
 * (ports, paths, ffmpeg locations) and passes its path as argv[2]; this file
 * loads it into process.env BEFORE the server bundle is imported, so every
 * env read in config.ts sees the values from the first moment.
 *
 * CJS on purpose: a .cjs entry is loadable under any embedder default, and the
 * dynamic import() below is how CJS legally loads the ESM server bundle.
 *
 * Kotlin also mirrors these into the real process environment with
 * android.system.Os.setenv before starting Node (belt and braces — whichever
 * lands first wins, the values are identical).
 */

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { pathToFileURL } = require('node:url');

const configPath = process.argv[2];
if (!configPath) {
  console.error('main.cjs: missing config path argument');
  process.exit(1);
}

const cfg = JSON.parse(readFileSync(configPath, 'utf8'));

// Env first — config.ts computes defaults from env at import time.
Object.assign(process.env, cfg.env ?? {});

// cwd second: relative paths (and any stray ./media default) resolve inside
// the app sandbox rather than wherever the embedder happened to start us.
if (cfg.cwd) process.chdir(cfg.cwd);

// os.tmpdir() does NOT read process.env: it goes through safeGetenv, which
// distrusts the environment when AT_SECURE is set — and Android app processes
// run with it set (SELinux domain transition at zygote exec). So despite
// TMPDIR being correct above, tmpdir() returns '/tmp', which bionic does not
// have, and every render dies writing its filter/caption temp files. Pin it.
// Patched BEFORE the server import so the bundle's `import { tmpdir }`
// snapshot picks up the override.
if (process.env.TMPDIR) {
  const os = require('node:os');
  const tmp = process.env.TMPDIR;
  require('node:fs').mkdirSync(tmp, { recursive: true });
  os.tmpdir = () => tmp;
}

// Surface crashes in logcat rather than dying silently — the Kotlin side
// watches for the health endpoint, and these lines are what explain a timeout.
process.on('uncaughtException', (err) => {
  console.error('[jumpcut] uncaughtException:', err && err.stack ? err.stack : err);
});
process.on('unhandledRejection', (err) => {
  console.error('[jumpcut] unhandledRejection:', err && err.stack ? err.stack : err);
});

console.log('[jumpcut] booting server, PORT=' + process.env.PORT + ' MEDIA_DIR=' + process.env.MEDIA_DIR);

// The server bundle sits beside this file after the asset sync. A file URL,
// not a bare path: import() of an absolute Windows path throws, and this same
// file is what the desktop-side smoke test runs before an APK ever exists.
import(pathToFileURL(join(__dirname, 'server.mjs')).href).catch((err) => {
  console.error('[jumpcut] server failed to start:', err && err.stack ? err.stack : err);
  process.exit(1);
});
