/**
 * Turn the monorepo's server + web app into the two things Electron ships:
 *
 *   resources/server.mjs  — the Hono API, bundled to one self-contained file
 *   resources/web/        — the built React UI the server serves
 *
 * Run automatically by `npm run dist`. Identical in desktop/win and desktop/mac.
 * Requires `npm install` to have been run at the repo root, so esbuild can
 * resolve the server's imports (hono, @hono/node-server) from the workspace.
 *
 * Takes the target from --platform= and --arch=, defaulting to this machine.
 * That only matters for the one native binary we ship (see the SDK section
 * below), and `npm run dist` passes the same arch it hands electron-builder.
 */
import { build } from 'esbuild';
import { execSync, execFileSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..', '..');
const out = join(here, 'resources');

/** `--name=value` off the command line, or `fallback` when it was not passed. */
const flag = (name, fallback) =>
  process.argv.slice(2).find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

const targetPlatform = flag('platform', process.platform);
const targetArch = flag('arch', process.arch);

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
  // Bake the key in as a FALLBACK, not the live var: config.ts reads
  // process.env.ELEVENLABS_API_KEY || process.env.__BAKED_ELEVENLABS_KEY__, so
  // this only fills the second half. Defining ELEVENLABS_API_KEY itself here
  // would replace that getter's live process.env read with a frozen literal —
  // which broke the dashboard's runtime key editing (settings.ts) the app
  // ships with, since a key set later from the dashboard would never be seen.
  define: { 'process.env.__BAKED_ELEVENLABS_KEY__': JSON.stringify(asrKey) },
  // Bundled CJS deps (e.g. `ws`, pulled in via @hono/node-ws) call require()
  // for builtins like 'events' at runtime. esbuild's CJS→ESM interop only
  // works if a global `require` exists, which a plain .mjs file doesn't have
  // — without this banner those calls throw "Dynamic require is not supported".
  banner: {
    js: "import { createRequire as __topLevelCreateRequire } from 'node:module';\nconst require = __topLevelCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});

// Ship the SDK beside the bundle so its `import '@anthropic-ai/claude-agent-sdk'`
// resolves at runtime, and so the native CLI it spawns sits on disk. resources/
// is copied verbatim by electron-builder's extraResources and is NOT packed into
// the asar, so the binary stays executable.
//
// That CLI is a per-platform package — @anthropic-ai/claude-agent-sdk-darwin-arm64,
// -win32-x64, and so on — pinned to the SDK's exact version and gated by `os`/`cpu`,
// so a plain `npm install` only ever fetches the BUILD MACHINE's. This step used to
// copy whichever ones happened to be in node_modules, which is how an Intel Mac
// produced an Apple Silicon app carrying the darwin-x64 CLI: the app launched, the
// editor worked, and every message to the assistant came back "Claude's local CLI
// isn't available", because agent-claude.ts looks up -darwin-arm64 and there was
// nothing there. The same shape as the ffmpeg/ffprobe trap, one layer further out.
//
// So name the target rather than trust the machine, and when this machine does not
// have that package, fetch it with `npm pack` — which downloads a tarball without
// consulting os/cpu, and so can pull a platform this one cannot install.
const sdkScope = join(repo, 'node_modules', '@anthropic-ai');
const sdkDst = join(out, 'node_modules', '@anthropic-ai');
if (!existsSync(join(sdkScope, 'claude-agent-sdk'))) {
  throw new Error(
    '@anthropic-ai/claude-agent-sdk not found in node_modules — run `npm install` at the repo root first.',
  );
}
const sdkVersion = JSON.parse(
  readFileSync(join(sdkScope, 'claude-agent-sdk', 'package.json'), 'utf8'),
).version;
const native = `claude-agent-sdk-${targetPlatform}-${targetArch}`;
const cli = targetPlatform === 'win32' ? 'claude.exe' : 'claude';

console.log(`• copying Claude Agent SDK ${sdkVersion} → resources/node_modules`);
cpSync(join(sdkScope, 'claude-agent-sdk'), join(sdkDst, 'claude-agent-sdk'), { recursive: true });

if (existsSync(join(sdkScope, native, cli))) {
  console.log(`• copying ${native} (already installed here)`);
  cpSync(join(sdkScope, native), join(sdkDst, native), { recursive: true });
} else {
  // A quarter of a gigabyte over the wire, so this is slow. It only happens when
  // building for a platform other than this one.
  console.log(`• fetching ${native}@${sdkVersion} (not installed here)`);
  const tmp = mkdtempSync(join(tmpdir(), 'jumpcut-sdk-'));
  try {
    // cwd rather than --pack-destination, so no path has to survive the shell.
    const tgz = execSync(`npm pack @anthropic-ai/${native}@${sdkVersion} --silent`, {
      cwd: tmp,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
    }).trim();
    execFileSync('tar', ['-xzf', tgz], { cwd: tmp });
    cpSync(join(tmp, 'package'), join(sdkDst, native), { recursive: true });
  } catch (err) {
    // Offline, or a registry that will not serve this platform. Worth naming,
    // because the raw npm failure does not say what the build was trying to do.
    throw new Error(
      `Could not fetch ${native}@${sdkVersion}, the Claude CLI for this target.\n` +
        `The build machine does not have it installed, so it had to come from the\n` +
        `registry. Check the network, or build on a ${targetArch} machine.\n\n` +
        String(err?.message ?? err),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// cpSync and electron-builder both copy modes verbatim, so the execute bit has
// to be right this far back. The tarball records 0755 and npm honours it, but a
// stray umask or an unpack on a filesystem without the bit would drop it, and a
// CLI that cannot be executed fails exactly the way a missing one does. Setting
// it costs nothing. (This does assume a Unix host — cross-building the Mac app
// from Windows would need the bit restored some other way, but electron-builder
// cannot produce a signed .app there anyway.)
if (targetPlatform !== 'win32') chmodSync(join(sdkDst, native, cli), 0o755);

/**
 * The two Swift helpers, built here rather than at runtime.
 *
 * In development apple-speech.ts and caption-image.ts compile main.swift with
 * swiftc on first use, into a path beside the source. Neither works in a package:
 * the sources are not copied into the bundle, the bundle is read-only so the
 * output could not be written anyway, and a clean Mac has no Xcode to compile
 * with. Before this, a packaged app silently lost Apple on-device ASR — the model
 * simply did not appear in the picker, with no error anywhere.
 *
 * -target matters for the same reason afterPack.cjs checks architectures at all:
 * nothing else stops an Intel build machine from putting x86_64 helpers inside an
 * arm64 app, and the failure then happens on the user's machine.
 *
 * macOS 26 for the ASR one specifically — SpeechAnalyzer does not exist before it.
 * Both are skipped on non-Mac targets, and --no-swift opts out entirely.
 */
if (targetPlatform === 'darwin' && !flag('no-swift', false)) {
  const macosTarget = `${targetArch === 'x64' ? 'x86_64' : 'arm64'}-apple-macos26.0`;
  const nativeOut = join(out, 'native');
  mkdirSync(nativeOut, { recursive: true });

  const helpers = [
    ['apple-speech', 'jumpcut-stt', 'Apple on-device transcription'],
    ['caption-render', 'jumpcut-captions', 'burned-in captions'],
  ];

  for (const [dir, bin, what] of helpers) {
    const src = join(repo, 'apps', 'server', 'native', dir, 'main.swift');
    if (!existsSync(src)) throw new Error(`Missing ${src} — cannot build the helper for ${what}.`);
    console.log(`• compiling ${bin} (${macosTarget})`);
    try {
      execFileSync('swiftc', ['-O', '-target', macosTarget, src, '-o', join(nativeOut, bin)], {
        stdio: ['ignore', 'inherit', 'inherit'],
      });
    } catch (err) {
      // Failing the build is the point. Continuing would ship an app that quietly
      // lacks the feature, which is the bug this block exists to fix.
      throw new Error(
        `Could not compile ${bin}, needed for ${what}.\n` +
          'Install the Xcode command line tools (xcode-select --install) on the BUILD\n' +
          'machine — the user\'s machine does not need them once this is shipped.\n' +
          'Pass --no-swift to build without it, losing that feature.\n\n' +
          String(err?.message ?? err),
      );
    }
    chmodSync(join(nativeOut, bin), 0o755);
  }
}

console.log('• building web app (vite)');
execSync('npm run build --workspace apps/web', { cwd: repo, stdio: 'inherit' });
cpSync(join(repo, 'apps', 'web', 'dist'), join(out, 'web'), { recursive: true });

console.log('✓ resources ready');
