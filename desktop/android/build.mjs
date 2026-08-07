/**
 * Bundle the monorepo's server + web app into the Android app's assets:
 *
 *   app/src/main/assets/nodejs-project/server.mjs   — the Hono API, one file
 *   app/src/main/assets/nodejs-project/main.cjs     — the Node bootstrap (env from config JSON)
 *   app/src/main/assets/nodejs-project/web/         — the built React UI the server serves
 *   app/src/main/assets/nodejs-project/version.txt  — content hash; the Kotlin
 *                                                     asset-sync re-copies when it changes
 *
 * Derived from desktop/win/build.mjs, with two deliberate deltas:
 *
 *   1. target node18 — nodejs-mobile's core is Node 18, not Electron's 20.
 *      Never target above the shipped libnode core (see third_party/fetch-libnode.mjs
 *      for the pinned release).
 *   2. The Claude Agent SDK is STUBBED OUT, not externalized. On desktop it is
 *      kept external because it spawns a native CLI; there is no Android build
 *      of that CLI at all, so the whole module is replaced with
 *      stubs/agent-claude.ts and no node_modules ship in the APK.
 *
 * Run automatically by the Gradle preBuild hook (`npm run prepare-assets`).
 * Requires `npm install` at the repo root first.
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = join(here, 'app', 'src', 'main', 'assets', 'nodejs-project');

/**
 * Empty the output directory, keeping the directory itself.
 *
 * `rmSync(out, { recursive: true })` is the obvious spelling and it is wrong on
 * Windows: `force` only swallows ENOENT, and a directory whose CONTENTS are all
 * deletable still fails with EPERM if anything holds a handle on the directory —
 * a Gradle daemon, an editor, an antivirus scan, a shell sitting in it. The old
 * code then aborted having already deleted everything inside, which is the worst
 * of the three outcomes: no build, and no payload either.
 *
 * What actually matters is that no stale file survives into the APK, and
 * deleting the children achieves that. Removing the empty directory afterwards
 * is cosmetic, so it is attempted and forgiven.
 */
function emptyDir(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // not there yet — the mkdir below makes it
  }
  for (const name of entries) rmSync(join(dir, name), { recursive: true, force: true });
  try {
    rmSync(dir, { recursive: true });
  } catch {
    /* held open by something else; empty is all we needed */
  }
}

/**
 * Keys are baked into the shipped app exactly as on desktop: an env var wins,
 * otherwise the repo's .env. They land in the compiled server.mjs and NOT in
 * git — treat a built APK as private, anyone who has it has the keys.
 *
 * Neither is required. No ElevenLabs key → the app ships on the mock ASR
 * provider, which costs nothing. No Gemini key → the Images panel imports files
 * but cannot generate them. Both can be added later from the app's own API-keys
 * dialog, which on a phone is the ONLY way to set one: there is no .env on
 * Android and no shell to export from. A key set there always wins over a baked
 * one (see the getters in apps/server/src/config.ts).
 */
const NAMES = ['ELEVENLABS_API_KEY', 'GEMINI_API_KEY'];
// Load the .env only if something is missing from the environment, and read the
// env AFTER: an env var set on the command line must still win, and loadEnvFile
// throws when there is no file at all.
if (NAMES.some((n) => !process.env[n])) {
  const before = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  try {
    process.loadEnvFile(join(repo, '.env'));
  } catch {
    /* no .env on this machine — whatever is in the environment stands alone */
  }
  for (const [n, v] of Object.entries(before)) if (v) process.env[n] = v;
}
const asrKey = process.env.ELEVENLABS_API_KEY ?? '';
const geminiKey = process.env.GEMINI_API_KEY ?? '';
console.log(
  asrKey
    ? `• baking in ElevenLabs key (…${asrKey.slice(-4)})`
    : '• no ElevenLabs key found — app will use mock ASR',
);
console.log(
  geminiKey
    ? `• baking in Gemini key (…${geminiKey.slice(-4)})`
    : '• no Gemini key found — images can be imported but not generated',
);

emptyDir(out);
mkdirSync(out, { recursive: true });

console.log('• bundling server → assets/nodejs-project/server.mjs');
await build({
  entryPoints: [join(repo, 'apps', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  // nodejs-mobile's core. Raise only in step with the libnode release pinned in
  // third_party/fetch-libnode.mjs.
  target: 'node18',
  outfile: join(out, 'server.mjs'),
  // Swap agent-claude.ts for the Android stub. An onResolve plugin, not
  // esbuild's `alias`: alias matches package names, and both import sites
  // (index.ts, agent.ts) use the RELATIVE './agent-claude.ts'.
  plugins: [
    {
      name: 'android-claude-stub',
      setup(b) {
        b.onResolve({ filter: /[\\/]agent-claude(\.ts)?$/ }, () => ({
          path: join(here, 'stubs', 'agent-claude.ts'),
        }));
      },
    },
  ],
  // Bake the keys in as FALLBACKS, not the live vars — same reasoning as
  // desktop/win/build.mjs: defining ELEVENLABS_API_KEY (or GEMINI_API_KEY)
  // itself would freeze the getter to the compiled-in string and break runtime
  // key editing from the dashboard (settings.ts), which is the only editing
  // there is on a phone.
  define: {
    'process.env.__BAKED_ELEVENLABS_KEY__': JSON.stringify(asrKey),
    'process.env.__BAKED_GEMINI_KEY__': JSON.stringify(geminiKey),
  },
  // Bundled CJS deps (e.g. `ws`, via @hono/node-ws) call require() for
  // builtins at runtime; a plain .mjs has no global require without this.
  banner: {
    js: "import { createRequire as __topLevelCreateRequire } from 'node:module';\nconst require = __topLevelCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

console.log('• copying bootstrap → assets/nodejs-project/main.cjs');
cpSync(join(here, 'nodejs-assets', 'main.cjs'), join(out, 'main.cjs'));

console.log('• building web app (vite)');
execSync('npm run build --workspace apps/web', { cwd: repo, stdio: 'inherit' });
cpSync(join(repo, 'apps', 'web', 'dist'), join(out, 'web'), { recursive: true });

// The version stamp the on-device asset sync compares. Hashing server.mjs +
// main.cjs + web/index.html covers everything: vite content-hashes its asset
// filenames, and index.html is what references them — so any web change moves
// index.html, and any server change moves server.mjs.
const h = createHash('sha256');
for (const f of ['server.mjs', 'main.cjs', join('web', 'index.html')]) {
  h.update(readFileSync(join(out, f)));
}
const version = h.digest('hex').slice(0, 16);
writeFileSync(join(out, 'version.txt'), version);
console.log(`✓ assets ready (version ${version})`);
