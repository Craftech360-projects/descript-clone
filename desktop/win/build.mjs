/**
 * Turn the monorepo's server + web app into the two things Electron ships:
 *
 *   resources/server.mjs  — the Hono API, bundled to one self-contained file
 *   resources/web/        — the built React UI the server serves
 *
 * Run automatically by `npm run dist`. Identical in desktop/win and desktop/mac.
 * Requires `npm install` to have been run at the repo root, so esbuild can
 * resolve the server's imports (hono, @hono/node-server) from the workspace.
 */
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = join(here, 'resources');

/**
 * The ElevenLabs key is baked into the shipped app: an env var wins, otherwise
 * the repo's .env. It is substituted into the server bundle below (esbuild
 * `define`), so it lives in the compiled resources/server.mjs and NOT in git.
 * Treat the resulting installer as private — anyone who has it has the key.
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

console.log('• bundling server → resources/server.mjs');
await build({
  entryPoints: [join(repo, 'apps', 'server', 'src', 'index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20', // Electron's bundled Node — keep in step with the electron version
  outfile: join(out, 'server.mjs'),
  // The Claude Agent SDK MUST stay external. It finds its native CLI binary with
  // createRequire(import.meta.url).resolve(...); inlined into server.mjs that
  // lookup runs from resources/ (no node_modules) and throws "Native CLI binary
  // for <platform> not found". Left external, sdk.mjs keeps its own import.meta.url
  // and resolves the platform package we copy in below.
  external: ['@anthropic-ai/claude-agent-sdk'],
  // Replace the one read of this env var with the literal key, so the compiled
  // server carries it. Every OTHER process.env.* stays a runtime lookup.
  define: { 'process.env.ELEVENLABS_API_KEY': JSON.stringify(asrKey) },
  logLevel: 'warning',
});

// Ship the SDK beside the bundle so its `import '@anthropic-ai/claude-agent-sdk'`
// resolves at runtime, and its native binary package (claude.exe / claude) sits
// on disk. resources/ is copied verbatim by electron-builder's extraResources and
// is NOT packed into the asar, so the binary stays executable. We copy every
// claude-agent-sdk* dir present — the SDK proper plus whichever platform packages
// this machine's `npm install` fetched (win32-x64 here, darwin-* on a Mac).
console.log('• copying Claude Agent SDK → resources/node_modules');
const sdkScope = join(repo, 'node_modules', '@anthropic-ai');
const sdkDst = join(out, 'node_modules', '@anthropic-ai');
const sdkDirs = readdirSync(sdkScope).filter((n) => n.startsWith('claude-agent-sdk'));
if (!sdkDirs.some((n) => n === 'claude-agent-sdk')) {
  throw new Error('@anthropic-ai/claude-agent-sdk not found in node_modules — run `npm install` at the repo root first.');
}
if (!sdkDirs.some((n) => n.startsWith('claude-agent-sdk-'))) {
  throw new Error('No native claude-agent-sdk-<platform> package installed — run `npm install` WITHOUT --omit=optional so the CLI binary ships.');
}
for (const name of sdkDirs) {
  cpSync(join(sdkScope, name), join(sdkDst, name), { recursive: true });
}

console.log('• building web app (vite)');
execSync('npm run build --workspace apps/web', { cwd: repo, stdio: 'inherit' });
cpSync(join(repo, 'apps', 'web', 'dist'), join(out, 'web'), { recursive: true });

console.log('✓ resources ready');
