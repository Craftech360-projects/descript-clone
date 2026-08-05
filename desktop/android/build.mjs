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
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = join(here, 'app', 'src', 'main', 'assets', 'nodejs-project');

/**
 * The ElevenLabs key is baked into the shipped app exactly as on desktop: an
 * env var wins, otherwise the repo's .env. It lands in the compiled server.mjs
 * and NOT in git — treat a built APK as private, anyone who has it has the key.
 * No key found → the app ships on the mock provider, which costs nothing.
 */
let asrKey = process.env.ELEVENLABS_API_KEY ?? '';
if (!asrKey) {
  try {
    process.loadEnvFile(join(repo, '.env'));
    asrKey = process.env.ELEVENLABS_API_KEY ?? '';
  } catch {
    /* no .env on this machine — fall through to mock ASR */
  }
}
console.log(
  asrKey
    ? `• baking in ElevenLabs key (…${asrKey.slice(-4)})`
    : '• no ElevenLabs key found — app will use mock ASR',
);

rmSync(out, { recursive: true, force: true });
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
  // Bake the key in as a FALLBACK, not the live var — same reasoning as
  // desktop/win/build.mjs: defining ELEVENLABS_API_KEY itself would freeze the
  // getter and break runtime key editing from the dashboard (settings.ts).
  define: { 'process.env.__BAKED_ELEVENLABS_KEY__': JSON.stringify(asrKey) },
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
