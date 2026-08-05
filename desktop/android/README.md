# Android build

Package this project as an Android APK that runs **everything on the phone**:
the same Hono server as dev/Docker/desktop, running in-process via
[nodejs-mobile](https://github.com/nodejs-mobile/nodejs-mobile), spawning a
bundled ffmpeg — no hosted server, no network needed to edit and render.

The shape mirrors `desktop/win` and `desktop/mac`: a thin native shell around
the unchanged product. Where Electron spawns `server.mjs` as a Node child and
opens a `BrowserWindow`, this app boots Node **inside the app process** (libnode
can't be a child — there is no Node executable on Android) and opens a WebView
at `http://127.0.0.1:<port>`.

## How it works

| Desktop (Electron) | Android |
| --- | --- |
| `spawn(node, server.mjs, { env })` | libnode in-process; env via `node-config.json`, applied by `nodejs-assets/main.cjs` **before** the server is imported |
| ffmpeg-static binaries, unpacked from asar | ffmpeg built for bionic/arm64, shipped as `jniLibs/arm64-v8a/libffmpeg.so` — the `lib*.so` name is what gets it installed *executable* into `nativeLibraryDir` (the only exec-allowed path on API 29+) |
| `MEDIA_DIR` → Electron userData | `MEDIA_DIR` → the app's `filesDir/media` |
| resources copied by electron-builder | `assets/nodejs-project/` copied to `filesDir` on first run / version change (Hono's `serveStatic` needs real files; APK assets aren't a filesystem) |
| health-poll `/api/health`, then `loadURL` | same poll, then `WebView.loadUrl` |
| `will-download` → native Save dialog | `window.JumpCutAndroid` JS bridge → MediaStore Downloads (see `DownloadBridge.kt`; the web side prefers it in `apps/web/src/download.ts`) |

Android-only env additions: `TMPDIR` (bionic has no `/tmp`, and the render
writes filter scripts to `os.tmpdir()`), `HOME`/`XDG_CACHE_HOME` (fontconfig's
cache, for burned captions).

The Claude assistant is **stubbed out** of the Android bundle (its SDK spawns a
native CLI that has no Android build) — `stubs/agent-claude.ts`, swapped in by
`build.mjs`. The Grok assistant is plain HTTP and works when a key is set.

## Build

Prerequisites: Node 20.12+, JDK 17+, Android SDK with NDK r27 + CMake 3.22
(Android Studio installs all of these), and once at the repo root: `npm install`.

```bash
cd desktop/android
npm install               # esbuild for the bundler
npm run fetch-libnode     # nodejs-mobile v18.20.4 → jniLibs + cpp headers
# ffmpeg/ffprobe: see third_party/ffmpeg/README.md — build once in WSL/Linux,
# copy out/libffmpeg.so + out/libffprobe.so into app/src/main/jniLibs/arm64-v8a/
./gradlew assembleDebug   # runs build.mjs automatically (Gradle preBuild hook)
```

The APK lands in `app/build/outputs/apk/debug/`. Install with
`adb install -r app-debug.apk`.

**The app builds without the ffmpeg binaries** — it will boot, and the splash
will report that the editor service failed, because `/api/health` honestly
returns 503 when ffmpeg cannot run. That distinction is deliberate (it is the
M0 spike's diagnostic): *timeout* = Node didn't boot; *503* = Node is up,
ffmpeg isn't. Watch both sides with:

```bash
adb logcat -s jumpcut-node jumpcut-shell
```

`jumpcut-node` is the server's own stdout/stderr (every `console.log` in
`server.mjs`), piped to logcat by the JNI bridge. `jumpcut-shell` is the
Kotlin side.

## The ElevenLabs key

Baked at build time exactly as on desktop: `ELEVENLABS_API_KEY` env var wins,
else the repo-root `.env`, else the app ships on mock ASR (everything works,
transcription is fake, nothing billed). **A built APK containing a key is
private** — anyone who has it can extract the key and spend the credit.

## Known constraints

- **Node starts once per process.** libnode cannot be restarted; if the server
  dies, the shell shows an error screen and relaunches the whole process.
- **arm64-v8a only.** nodejs-mobile ships other ABIs, but a second ABI doubles
  a ~100MB native payload for devices too weak for video rendering.
- **Renders are software x264** (`veryfast`) — expect minutes, not seconds, on
  long videos. A `h264_mediacodec` hardware-encode path is a possible later
  change to `packages/core/src/render.ts`, reviewed cross-platform.
- **Some codecs won't preview** in the WebView `<video>` even though the render
  handles them — WebView's codec set is narrower than desktop Chromium's.
- **GPL**: the bundled ffmpeg includes x264 — see `third_party/ffmpeg/README.md`
  before distributing beyond private use.
- **Esbuild targets node18** because that is nodejs-mobile's core. If you bump
  the release tag in `third_party/fetch-libnode.mjs`, bump the target in
  `build.mjs` with it.

## Roadmap (mirrors the plan's milestones)

- **M3 robustness**: a foreground service + notification while a render runs,
  so backgrounding the app doesn't freeze the encode; keep-screen-on during
  jobs. `FOREGROUND_SERVICE`/`POST_NOTIFICATIONS` permissions are already in
  the manifest; `RenderService.kt` is the intended home.
- **M4 ship**: signing config, ffmpeg size-trim pass, launcher icon
  (`build/icon.png` convention from the desktop folders).
