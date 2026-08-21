'use strict';

/**
 * Electron main process — the desktop shell, and nothing more.
 *
 * It does three things: locate the ffmpeg/ffprobe binaries this app ships, start
 * the bundled Hono server as a Node child on a free port, and point a window at
 * it. The server it starts is byte-for-byte the server that runs in dev and
 * Docker (see ../../apps/server) — no product logic lives here.
 *
 * NOTE: this file is intentionally identical in desktop/win and desktop/mac.
 * If you edit one, edit the other. The only per-platform difference is the
 * "build" block in package.json.
 */

const { app, BrowserWindow, Menu, dialog, session } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// A native binary cannot execute from inside app.asar, so electron-builder is
// told to leave the ffmpeg/ffprobe packages unpacked (see asarUnpack). Rewrite
// the require()'d path to the unpacked copy. In dev the path has no "app.asar",
// so this is a no-op.
//
// ffprobe comes from @ffprobe-installer/ffprobe and NOT from ffprobe-static,
// and the two are not interchangeable. ffprobe-static@3.1.0 ships an x86_64
// Mach-O at bin/darwin/arm64/ffprobe — the folder says arm64, the file's header
// says CPU_TYPE_X86_64 (run `file` on it, or read bytes 4-8: 07 00 00 01). So
// the Apple Silicon build carried an Intel ffprobe, which runs only on a Mac
// that happens to have Rosetta 2 installed and otherwise cannot be spawned at
// all: the app launched, and then every import died on the media probe.
// @ffprobe-installer resolves a per-platform package instead
// (@ffprobe-installer/darwin-arm64, win32-x64, …), each holding a binary that
// really is the architecture it advertises.
const unpacked = (p) => p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
const ffmpegPath = unpacked(require('ffmpeg-static'));
const ffprobePath = unpacked(require('@ffprobe-installer/ffprobe').path);

let serverProc = null;

/**
 * Fail at launch if a shipped binary did not survive packaging.
 *
 * Without this the window opens, the editor looks fine, and the first import
 * comes back with "Could not run <long path>/ffprobe. Is it on PATH?" — which
 * reads as a bug in the editor rather than as a broken build. The binaries are
 * lifted out of the asar by path (see asarUnpack), so any change to these two
 * dependencies can quietly stop matching; this is the check that says so.
 */
function binariesPresent() {
  const missing = [
    ['ffmpeg', ffmpegPath],
    ['ffprobe', ffprobePath],
  ].filter(([, bin]) => !fs.existsSync(bin));

  if (missing.length === 0) return true;

  dialog.showErrorBox(
    'Broken installation',
    `This build is missing ${missing.map(([name]) => name).join(' and ')}.\n\n` +
      `${missing.map(([, bin]) => bin).join('\n')}\n\n` +
      'Reinstall the app. If you built it yourself, check "asarUnpack" in package.json.',
  );
  return false;
}

/** Ask the OS for a free port, so we never collide with a running dev server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/** Packaged: extraResources land in resourcesPath. Dev: build.mjs writes them here. */
function resourcesDir() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resources');
}

function startServer(port, userData) {
  const res = resourcesDir();
  serverProc = spawn(process.execPath, [path.join(res, 'server.mjs')], {
    env: {
      ...process.env,
      // Run Electron's own Node as a plain Node, not a second app instance.
      ELECTRON_RUN_AS_NODE: '1',
      PORT: String(port),
      MEDIA_DIR: path.join(userData, 'media'),
      WEB_DIST: path.join(res, 'web'),
      FFMPEG_PATH: ffmpegPath,
      FFPROBE_PATH: ffprobePath,
      // Same reasoning as MEDIA_DIR: settings.ts's default path is computed
      // relative to its own (bundled) file location, which resolves outside
      // the app once packaged — e.g. /Applications on Mac, C:\ on Windows.
      // userData is the one place Electron guarantees is per-user writable.
      SETTINGS_PATH: path.join(userData, '.jumpcut-secrets.json'),
      // The ElevenLabs key is compiled into server.mjs at build time
      // (see build.mjs) — nothing to inject here.
    },
    stdio: ['ignore', 'inherit', 'inherit'],
  });

  serverProc.on('exit', (code) => {
    const wasRunning = serverProc !== null;
    serverProc = null;
    if (wasRunning && !app.isQuitting) {
      dialog.showErrorBox('Editor stopped', `The background service exited (code ${code}).`);
      app.quit();
    }
  });
}

/** Poll until the server answers, so the window never opens on a refused port. */
async function waitForServer(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  const url = `http://127.0.0.1:${port}/api/health`;
  while (Date.now() < deadline) {
    try {
      await fetch(url); // any HTTP answer — even 503 — means it is listening
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return false;
}

async function main() {
  await app.whenReady();
  if (!binariesPresent()) {
    app.quit();
    return;
  }
  const userData = app.getPath('userData');
  const port = await freePort();
  startServer(port, userData);

  if (!(await waitForServer(port))) {
    dialog.showErrorBox('Startup failed', 'The editor service did not start in time.');
    app.quit();
    return;
  }

  // No File/Edit/View menu. Electron installs a default one, and every entry on
  // it is either a browser control this app has no use for (Reload, Zoom,
  // Toggle DevTools) or a promise it does not keep — a "File" menu that cannot
  // open or save a project reads as broken, not as unfinished.
  //
  // Not on macOS: there the menu bar belongs to the OS, and clearing it takes
  // Cmd+Q, Cmd+C and Cmd+V with it. The Mac gets the standard menu; Windows and
  // Linux get their window back.
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: '#0e0e12',
    // Belt and braces: without a menu there is nothing to auto-hide, but this
    // also stops Alt from summoning one if a menu is ever set again.
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  installSaveDialog(win);
  win.loadURL(`http://127.0.0.1:${port}`);
}

/**
 * Turn the app's one download — the finished render — into a real Save dialog.
 *
 * Chromium's default is to write to the downloads folder and say nothing. In a
 * browser that is fine, because the browser has a downloads shelf to tell you
 * where it went. Here there is no shelf, so a finished render simply vanishes:
 * the encode succeeded, the file exists, and the user has no idea where. Ask.
 *
 * setSavePath must be called synchronously from the event, so this uses the
 * blocking dialog on purpose.
 */
function installSaveDialog(win) {
  // Sensible on the second save: people put their exports in one place.
  let lastDir = null;

  session.defaultSession.on('will-download', (_event, item) => {
    const name = item.getFilename();
    const ext = path.extname(name).replace('.', '') || 'mp4';
    const chosen = dialog.showSaveDialogSync(win, {
      title: 'Save render',
      defaultPath: path.join(lastDir ?? app.getPath('videos'), name),
      filters: [
        { name: ext.toUpperCase(), extensions: [ext] },
        { name: 'All files', extensions: ['*'] },
      ],
    });

    if (!chosen) {
      item.cancel(); // The monitor keeps a link, so cancelling loses nothing.
      return;
    }

    lastDir = path.dirname(chosen);
    item.setSavePath(chosen);

    item.once('done', (__event, state) => {
      // "cancelled" is the user's own doing above; only real failures are news.
      if (state === 'interrupted') {
        dialog.showErrorBox('Save failed', `Could not write ${chosen}.`);
      }
    });
  });
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  app.isQuitting = true;
  if (serverProc) {
    const p = serverProc;
    serverProc = null;
    p.kill();
  }
});

main();
