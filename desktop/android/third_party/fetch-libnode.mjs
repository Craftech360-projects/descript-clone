/**
 * Fetch the pinned nodejs-mobile release and install its pieces where the
 * build expects them:
 *
 *   app/src/main/jniLibs/arm64-v8a/libnode.so   — the Node runtime the app links
 *   app/src/main/cpp/libnode/include/node/      — headers the JNI bridge compiles against
 *
 * nodejs-mobile has no maintained Maven artifact; the release zip is the
 * documented integration path (see the native-gradle sample in
 * nodejs-mobile-samples). The tag below pins BOTH the runtime and, indirectly,
 * the esbuild target in ../build.mjs — its core is Node 18, so the server
 * bundle targets node18. If you bump this tag to a release with a newer core,
 * raise that target with it.
 *
 * Downloads are cached in third_party/cache/ so repeat runs are offline.
 */
import { createWriteStream, existsSync, mkdirSync, cpSync, rmSync, readdirSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

// The pinned release. v18.20.4 is the current Node-18-core line; check
// https://github.com/nodejs-mobile/nodejs-mobile/releases before bumping.
const TAG = process.env.NODEJS_MOBILE_TAG ?? 'v18.20.4';
const ZIP_NAME = `nodejs-mobile-${TAG}-android.zip`;
const URL = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/${TAG}/${ZIP_NAME}`;

const here = dirname(fileURLToPath(import.meta.url));
const android = resolve(here, '..');
const cache = join(here, 'cache');
const zipPath = join(cache, ZIP_NAME);
const extractDir = join(cache, `nodejs-mobile-${TAG}`);

const jniLibsDir = join(android, 'app', 'src', 'main', 'jniLibs', 'arm64-v8a');
const includeDst = join(android, 'app', 'src', 'main', 'cpp', 'libnode', 'include');

mkdirSync(cache, { recursive: true });

if (!existsSync(zipPath)) {
  console.log(`• downloading ${URL}`);
  const res = await fetch(URL, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(
      `Download failed: HTTP ${res.status}. Check the release tag "${TAG}" exists at ` +
        'https://github.com/nodejs-mobile/nodejs-mobile/releases — the asset naming ' +
        'convention may also have changed.',
    );
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(zipPath));
} else {
  console.log(`• using cached ${ZIP_NAME}`);
}

console.log('• extracting');
rmSync(extractDir, { recursive: true, force: true });
mkdirSync(extractDir, { recursive: true });
// bsdtar reads zips and ships with Windows 10+ and macOS; plain `unzip` covers
// the Linux distros whose GNU tar does not.
try {
  execSync(`tar -xf "${zipPath}" -C "${extractDir}"`, { stdio: 'inherit' });
} catch {
  execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });
}

// Release zips have historically nested content one directory down; take
// whichever level holds bin/ and include/.
const root = existsSync(join(extractDir, 'bin')) ? extractDir : findRoot();
function findRoot() {
  for (const name of readdirSync(extractDir)) {
    if (existsSync(join(extractDir, name, 'bin'))) return join(extractDir, name);
  }
  throw new Error(`Could not find bin/ inside ${extractDir} — release layout changed?`);
}

const soSrc = join(root, 'bin', 'arm64-v8a', 'libnode.so');
const incSrc = join(root, 'include');
if (!existsSync(soSrc)) throw new Error(`Missing ${soSrc} — release layout changed?`);
if (!existsSync(incSrc)) throw new Error(`Missing ${incSrc} — release layout changed?`);

mkdirSync(jniLibsDir, { recursive: true });
cpSync(soSrc, join(jniLibsDir, 'libnode.so'));
rmSync(includeDst, { recursive: true, force: true });
cpSync(incSrc, includeDst, { recursive: true });

console.log(`✓ libnode.so → ${jniLibsDir}`);
console.log(`✓ headers    → ${includeDst}`);
console.log('  (ffmpeg/ffprobe binaries are a separate step — see third_party/ffmpeg/)');
