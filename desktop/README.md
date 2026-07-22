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
- **macOS:** Gatekeeper blocks an unsigned app on double-click. **Right-click →
  Open** the first time, then confirm. A full fix needs an Apple Developer
  account ($99/yr) and notarization, which also requires building on a Mac.

## App icon (optional)

Drop a 512×512 `build/icon.png` in the platform folder and electron-builder will
use it (it generates `.ico`/`.icns` automatically). Without one you get the
default Electron icon — fine for internal use.

## A note on ffmpeg licensing

`ffmpeg-static` ships a GPL build of ffmpeg (it includes x264). That's a
non-issue for private use between a couple of people, but it constrains
redistribution if this ever ships more widely — worth knowing before it does.
