'use strict';

/**
 * Post-package checks for the Mac build: verify the three native binaries we
 * just shipped are really there and really the architecture we built for, then
 * ad-hoc sign the .app.
 *
 * All of it exists because of failures we actually hit.
 *
 * The arch check: not one of the three is chosen by the build, they are chosen
 * by whatever machine last fetched them. ffmpeg-static downloads exactly ONE
 * ffmpeg, for that machine; @ffprobe-installer installs one platform package
 * (@ffprobe-installer/darwin-arm64, darwin-x64, ...) the same way; and the
 * Claude Agent SDK's CLI is a third (@anthropic-ai/claude-agent-sdk-darwin-*).
 * So `--arm64` on an Intel Mac produces an Apple Silicon app with x86_64 tools
 * inside — it launches fine, and then fails on the first import, the first
 * render, or the first message to the assistant, each with an error that looks
 * unrelated to the others. Cheaper to fail the build here than to debug that.
 *
 * It is also why ffprobe does NOT come from ffprobe-static, which looks like it
 * sidesteps the whole problem by shipping every arch at once: its
 * bin/darwin/arm64/ffprobe is an x86_64 binary (`file` says so). That build ran
 * under Rosetta 2 on the Macs that had it and could not be spawned at all on
 * the ones that did not, which is the bug this check would have caught.
 *
 * The presence check: the media tools are pulled out of app.asar by path
 * (asarUnpack in package.json) and the CLI rides along in resources/
 * (extraResources). Change a dependency, forget the pattern, and
 * electron-builder says nothing — the app ships with the tool sealed inside
 * the archive, or missing outright, and either way it cannot be run.
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
  // The media tools are lifted out of the archive by asarUnpack; the Agent SDK
  // and its CLI are copied in whole by extraResources, one level up from those.
  const unpacked = path.join(appPath, 'Contents/Resources/app.asar.unpacked/node_modules');
  const shipped = path.join(appPath, 'Contents/Resources/node_modules');

  const wanted = ARCH_NAMES[context.arch];
  const nodeArch = NODE_ARCH[context.arch];

  // Two different fetches, so two different fixes. The media tools need both
  // settings: --arch picks ffmpeg-static's download, --cpu picks the
  // @ffprobe-installer platform package. The CLI is build.mjs's job — it takes
  // the target and fetches that platform's package itself.
  const tools = `npm run tools -- --arch=${nodeArch} --cpu=${nodeArch}`;
  const rebuild = `npm run build -- --platform=darwin --arch=${nodeArch}`;

  const binaries = [
    {
      pkg: 'ffmpeg-static',
      bin: path.join(unpacked, 'ffmpeg-static/ffmpeg'),
      fix: tools,
    },
    {
      pkg: '@ffprobe-installer/ffprobe',
      bin: path.join(unpacked, '@ffprobe-installer', `darwin-${nodeArch}`, 'ffprobe'),
      fix: tools,
    },
    {
      pkg: `@anthropic-ai/claude-agent-sdk-darwin-${nodeArch}`,
      bin: path.join(shipped, '@anthropic-ai', `claude-agent-sdk-darwin-${nodeArch}`, 'claude'),
      fix: rebuild,
    },
  ];

  // A universal build is two per-arch builds merged; there is no single slice
  // to compare against, and no `darwin-universal` platform package to look for.
  for (const { pkg, bin, fix } of (nodeArch ? binaries : [])) {
    if (!existsSync(bin)) {
      throw new Error(
        `${pkg} did not make it into the packaged app.\n` +
          `  expected: ${bin}\n\n` +
          `Rebuild the resources for this target:\n` +
          `  ${fix}\n\n` +
          `If that still does not produce it, check the packaging rules in\n` +
          `package.json — "asarUnpack" for the media tools, "extraResources"\n` +
          `for resources/. A binary left inside app.asar cannot be executed,\n` +
          `and the app only finds out when something tries to spawn it.`,
      );
    }

    // `file` names every slice in the binary; a universal build lists several.
    // -b for brief: without it the output starts with the path, and two of these
    // paths contain the arch (…/darwin-arm64/ffprobe), so the match below would
    // be satisfied by the folder name and never look at the binary at all.
    const described = execFileSync('file', ['-b', bin], { encoding: 'utf8' });
    if (wanted !== 'universal' && !described.includes(wanted)) {
      throw new Error(
        `${pkg} is the wrong architecture for this build.\n` +
          `  building for: ${wanted}\n` +
          `  binary is:    ${described.trim()}\n\n` +
          `Nothing here is chosen by electron-builder — it is chosen by whatever\n` +
          `last fetched this binary. Either build on a ${wanted} Mac, or fetch\n` +
          `the target's copy:\n` +
          `  ${fix}`,
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
