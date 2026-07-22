'use strict';

/**
 * Post-package checks for the Mac build: verify the shipped ffmpeg matches the
 * architecture we're building for, then ad-hoc sign the .app.
 *
 * Both steps exist because of failures we actually hit.
 *
 * The arch check: ffprobe-static ships a binary for every platform, but
 * ffmpeg-static downloads exactly ONE at `npm install` time, for the machine
 * that ran it. So `--arm64` on an Intel Mac produces an Apple Silicon app with
 * an x86_64 ffmpeg inside — it launches fine and then fails on the first
 * render. Cheaper to fail the build here than to debug that later.
 *
 * The signing: Apple Silicon will not execute an arm64 binary carrying no
 * signature at all. Unsigned, the app dies before main.cjs runs and Finder says
 * only that it "can't be opened". Intel Macs tolerated unsigned code, which is
 * why this bites on M-series and not on the machine it was built on. An ad-hoc
 * signature ("--sign -") is free and needs no Apple Developer account. It does
 * NOT notarize: a downloaded .dmg still needs one manual approval (../README.md).
 */
const { execFileSync } = require('node:child_process');
const path = require('node:path');

/** electron-builder's Arch enum → the token `file` prints for that slice. */
const ARCH_NAMES = { 0: 'i386', 1: 'x86_64', 2: 'arm', 3: 'arm64', 4: 'universal' };

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.app`,
  );

  const wanted = ARCH_NAMES[context.arch];
  const ffmpeg = path.join(
    appPath,
    'Contents/Resources/app.asar.unpacked/node_modules/ffmpeg-static/ffmpeg',
  );
  // `file` names every slice in the binary; a universal build lists several.
  const described = execFileSync('file', [ffmpeg], { encoding: 'utf8' });
  if (wanted !== 'universal' && !described.includes(wanted)) {
    throw new Error(
      `ffmpeg-static is the wrong architecture for this build.\n` +
        `  building for: ${wanted}\n` +
        `  ffmpeg is:    ${described.trim()}\n\n` +
        `ffmpeg-static downloads one binary for the machine that ran npm install.\n` +
        `Either build on a ${wanted} Mac, or refetch it for the target:\n` +
        `  npm_config_arch=${context.arch === 3 ? 'arm64' : 'x64'} npm install ffmpeg-static --force`,
    );
  }
  console.log(`  • ffmpeg arch ok (${wanted})`);

  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath],
    { stdio: 'inherit' },
  );
};
