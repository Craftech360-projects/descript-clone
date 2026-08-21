'use strict';

/**
 * Post-package checks for the Mac build: verify the ffmpeg and ffprobe we just
 * shipped are really there and really the architecture we built for, then
 * ad-hoc sign the .app.
 *
 * All of it exists because of failures we actually hit.
 *
 * The arch check: neither binary is chosen by the build, they are chosen by
 * whatever machine last ran `npm install`. ffmpeg-static downloads exactly ONE
 * ffmpeg, for that machine; @ffprobe-installer installs one platform package
 * (@ffprobe-installer/darwin-arm64, darwin-x64, ...) the same way. So `--arm64`
 * on an Intel Mac produces an Apple Silicon app with x86_64 tools inside — it
 * launches fine and then fails on the first import or the first render.
 * Cheaper to fail the build here than to debug that later.
 *
 * It is also why ffprobe does NOT come from ffprobe-static, which looks like it
 * sidesteps the whole problem by shipping every arch at once: its
 * bin/darwin/arm64/ffprobe is an x86_64 binary (`file` says so). That build ran
 * under Rosetta 2 on the Macs that had it and could not be spawned at all on
 * the ones that did not, which is the bug this check would have caught.
 *
 * The presence check: the binaries are pulled out of app.asar by path
 * (asarUnpack in package.json). Change a dependency, forget the pattern, and
 * electron-builder says nothing — the app ships with the tool sealed inside the
 * archive, where it cannot be executed.
 *
 * The signing: Apple Silicon will not execute an arm64 binary carrying no
 * signature at all. Unsigned, the app dies before main.cjs runs and Finder says
 * only that it "can't be opened". Intel Macs tolerated unsigned code, which is
 * why this bites on M-series and not on the machine it was built on. An ad-hoc
 * signature ("--sign -") is free and needs no Apple Developer account. It does
 * NOT notarize: a downloaded .dmg still needs one manual approval (../README.md).
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

/** electron-builder's Arch enum -> the token `file` prints for that slice. */
const ARCH_NAMES = { 0: 'i386', 1: 'x86_64', 2: 'arm', 3: 'arm64', 4: 'universal' };
/** ...and -> the Node arch name npm keys its platform packages by. */
const NODE_ARCH = { 0: 'ia32', 1: 'x64', 2: 'arm', 3: 'arm64' };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );
  const modules = path.join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules');

  const wanted = ARCH_NAMES[context.arch];
  const nodeArch = NODE_ARCH[context.arch];
  const refetch = `npm run tools -- --arch=${nodeArch} --cpu=${nodeArch}`;

  const binaries = [
    ['ffmpeg-static', path.join(modules, 'ffmpeg-static/ffmpeg')],
    [
      '@ffprobe-installer/ffprobe',
      path.join(modules, '@ffprobe-installer', `darwin-${nodeArch}`, 'ffprobe'),
    ],
  ];

  // A universal build is two per-arch builds merged; there is no single slice
  // to compare against, and no `darwin-universal` platform package to look for.
  for (const [pkg, bin] of (nodeArch ? binaries : [])) {
    if (!existsSync(bin)) {
      throw new Error(
        `${pkg} did not make it into the packaged app.\n` +
          `  expected: ${bin}\n\n` +
          `Run npm install in this folder, and check that "asarUnpack" in\n` +
          `package.json still covers ${pkg} — a binary left inside app.asar\n` +
          `cannot be executed, and the app only finds out on the first import.`,
      );
    }

    // `file` names every slice in the binary; a universal build lists several.
    const described = execFileSync('file', [bin], { encoding: 'utf8' });
    if (wanted !== 'universal' && !described.includes(wanted)) {
      throw new Error(
        `${pkg} is the wrong architecture for this build.\n` +
          `  building for: ${wanted}\n` +
          `  binary is:    ${described.trim()}\n\n` +
          `Both tools are downloaded for whatever machine ran npm install.\n` +
          `Either build on a ${wanted} Mac, or refetch this one for the target.\n` +
          `That is what the tools script does — both settings, because --arch\n` +
          `picks ffmpeg-static's download and --cpu picks the\n` +
          `@ffprobe-installer platform package:\n` +
          `  ${refetch}`,
      );
    }
    console.log(`  • ${pkg} ok (${wanted})`);
  }

  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );
};
