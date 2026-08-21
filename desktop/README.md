# Desktop builds

Package this project as a native desktop app, so it runs on one person's machine
with no server to host, no database, and no API key sitting on the internet. All
state lives in local files under the OS app-data folder — which is exactly what
`apps/server/src/store.ts` was already doing.

Two folders, one per platform:

| Folder | Builds | Build it on |
| ------ | ------ | ----------- |
| [`win/`](win/) | `.exe` installer (NSIS) | Windows |
| [`mac/`](mac/) | `.dmg` containing the `.app` | macOS |

## Why two folders instead of one

You can only build a Mac app on a Mac and a Windows app on Windows — code
signing, the packaged runtime, and the installer format are all
platform-native. So each folder is a **self-contained Electron project** you can
build on its own machine without dragging shared parent files along.

The cost of that choice: `main.cjs` and `build.mjs` are **byte-for-byte
identical** in both folders. If you change one, change the other. The only thing
that legitimately differs between them is the `"build"` block in `package.json`
(NSIS vs DMG, and the Mac `identity: null` that allows an unsigned build).

## How it works

Neither folder reimplements the app. At build time each one:

1. **Bundles the existing server** (`apps/server/src/index.ts` + `packages/core`)
   into one self-contained `resources/server.mjs` with esbuild. Node can't run
   the raw `.ts` sources inside Electron, so they're compiled ahead of time.
2. **Builds the web UI** (`apps/web`, Vite) into `resources/web/`.
3. Lets `electron-builder` wrap `main.cjs` + those resources + a bundled
   **ffmpeg/ffprobe** into an installer.

At runtime, `main.cjs` starts `server.mjs` as a background Node process on a free
port and opens a window pointing at it — the same Hono server as dev and Docker,
told via env vars where to put data (`MEDIA_DIR` → the app-data folder) and which
ffmpeg to use (`FFMPEG_PATH`/`FFPROBE_PATH` → the shipped binaries).

## Build steps

Once, at the repo root — the server bundle resolves its imports (`hono`, etc.)
from the workspace:

```
npm install
```

Then, in the platform folder **on the matching OS**:

```
cd desktop/win     # or desktop/mac
npm install
npm run dist
```

The installer lands in `desktop/<platform>/dist/`. To smoke-test without
packaging (opens the app straight from source): `npm start`.

### Mac: the build picks its own architecture

`npm run dist` builds **Apple Silicon (arm64)**. `npm run dist:intel` builds
x86_64. Neither cares which chip you build on: each one begins by refetching the
media tools for its own target, so cross-building the arm64 app from an Intel Mac
is just `npm run dist`. Electron and `codesign` cross-build without complaint, so
nothing else needs special handling.

That refetch is not optional, because neither media tool is chosen by the build.
`ffmpeg-static` downloads a single ffmpeg, and `@ffprobe-installer/ffprobe`
installs a single platform package — each for whatever machine last ran
`npm install`. Left to that, an Intel Mac produces an Apple Silicon app carrying
x86_64 tools: it launches fine and then dies on the first import or the first
render. `afterPack.cjs` checks both and fails the build rather than shipping it.

It takes two npm settings, and they are not interchangeable. `--arch=arm64` is
what `ffmpeg-static`'s install script reads to pick its download; `--cpu=arm64`
is what npm's own optional-dependency filter reads to pick which
`@ffprobe-installer/<platform>-<arch>` package to install. Pass only `--arch` and
you still get an x64 ffprobe. Both live in the `tools` script, which `dist` and
`dist:intel` call with their own target:

```
npm run tools -- --arch=arm64 --cpu=arm64
```

> One consequence worth knowing: after a `dist`, this folder's `node_modules`
> holds the **target's** binaries, not the build machine's. On an Intel Mac that
> means `npm start` cannot probe or render until you run a bare `npm run tools`
> to put the local ones back.

### Why ffprobe does not come from `ffprobe-static`

`ffprobe-static` looks like the easy answer: one package, a binary for every
platform, nothing downloaded per machine. It is not. The file it ships at
`bin/darwin/arm64/ffprobe` is an **x86_64** build — the folder says arm64 and the
Mach-O header says `CPU_TYPE_X86_64`, which `file` will confirm.

So the Apple Silicon app shipped an Intel ffprobe. It ran under Rosetta 2 on the
Macs that had Rosetta, and could not be spawned at all on the Macs that did not:
the app launched, the project list appeared, and every import failed with

```
Could not run …/app.asar.unpacked/node_modules/ffprobe-static/bin/darwin/arm64/ffprobe.
Is it on PATH? (spawn … ENOENT)
```

`@ffprobe-installer/ffprobe` resolves a per-platform package instead
(`@ffprobe-installer/darwin-arm64`, `win32-x64`, …) whose binary really is the
advertised architecture, and `afterPack.cjs` now verifies that on every Mac
build. ffmpeg was never affected — `ffmpeg-static` downloads the right one.

An Intel build does run on Apple Silicon via Rosetta, but macOS shows a
"Support Ending for Intel-Based Apps" warning and a future macOS will drop it.
Build arm64 for M-series machines.

## The ElevenLabs key

The key is **baked into the app at build time**. `build.mjs` reads it and esbuild
compiles it straight into `resources/server.mjs`, so the shipped app transcribes
for real with no setup by the user.

Where the key comes from at build time, in order:

1. An `ELEVENLABS_API_KEY` environment variable, if set (use this on a CI runner).
2. Otherwise the repo-root `.env` file's `ELEVENLABS_API_KEY`.

If neither exists, the app is built against the **mock** ASR provider — the whole
editor works, transcription is fake, nothing is billed.

> **The installer now contains your key.** Anyone who gets the `.exe`/`.dmg` can
> extract it and spend your ElevenLabs credit, so treat the built installer as
> private — don't post it publicly or attach it to a public release. The key
> lives only in `.env` and in the compiled bundle; it is never committed to git.

## Signing — the honest state

Neither build is code-signed, because signing certificates cost money and this
is for a couple of known users:

- **Windows:** SmartScreen shows an "unrecognized app" warning on first run.
  Click **More info → Run anyway**, once. A code-signing cert (~$200+/yr)
  removes it.
- **macOS:** the build is **ad-hoc signed** (`afterPack.cjs`, `codesign --sign -`).
  That is not optional on Apple Silicon: an arm64 binary with no signature at all
  is refused by the kernel, and the app fails to launch with a bare "can't be
  opened" — not even a Gatekeeper prompt. Ad-hoc signing costs nothing and needs
  no Apple account.

  It is still not *notarized*, so a `.dmg` that arrives by download or AirDrop
  carries the quarantine flag and Gatekeeper stops it once. On macOS 15+ the old
  right-click → Open trick is gone; the user must open **System Settings →
  Privacy & Security**, scroll to the blocked-app notice, and click **Open
  Anyway**. Or, from a terminal:

  ```
  xattr -dr com.apple.quarantine "/Applications/Transcript Editor.app"
  ```

  A full fix needs an Apple Developer account ($99/yr) plus notarization, which
  also requires building on a Mac.

## App icon (optional)

Drop a 512×512 `build/icon.png` in the platform folder and electron-builder will
use it (it generates `.ico`/`.icns` automatically). Without one you get the
default Electron icon — fine for internal use.

## A note on ffmpeg licensing

`ffmpeg-static` ships a GPL build of ffmpeg (it includes x264). That's a
non-issue for private use between a couple of people, but it constrains
redistribution if this ever ships more widely — worth knowing before it does.
