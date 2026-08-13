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
| `<input type=file>` → OS dialog | `WebChromeClient.onShowFileChooser` → `ACTION_GET_CONTENT`; results read with `FileChooserParams.parseResult` (Android 13+ sends an `image/*` pick to the photo picker, which answers in `clipData`, not `getData`) |

Android-only env additions: `TMPDIR` (bionic has no `/tmp`, and the render
writes filter scripts to `os.tmpdir()`), `HOME`/`XDG_CACHE_HOME` (fontconfig's
cache, for burned captions).

## The assistant on a phone

The Grok backend is plain HTTP and works when a key is set, and it carries the
**whole** tool contract — all of `packages/core/src/agent-tools.ts`, the same
list the desktop build serves, verified present in the bundle after every
`prepare-assets`. Nothing in the tool surface is desktop-only.

The **Claude** backend is stubbed out (`stubs/agent-claude.ts`, swapped in by
`build.mjs`): its SDK locates and spawns a native CLI, and there is no Android
build of that binary. `CONFIG.hasClaude()` is env-gated and no Claude token is
ever set here, so the picker never offers it. Reaching Claude on-device would
mean a second transport that speaks the Messages API over plain HTTP, the way
the Grok loop already does — a real piece of work, not a packaging change.

Two capabilities need the phone's own limits taken into account, and
`NodeRuntime.kt` sets both:

| | why |
| --- | --- |
| `SUMMON_OP_TIMEOUT_S=420` | the assistant's improvised ffmpeg operations (`run_media_op`) run under a wall-clock cap whose default, two minutes, is a laptop number. Software x264 on arm64 is an order of magnitude slower; the default would kill work that is progressing. |
| `SUMMON_MAX_MB=96` | the cap on one file fetched from a URL **the model chose**. 256 MB is defensible on a workstation and not on a phone. |

Codecs are negotiated rather than assumed. `summon.ts` asks the binary what it
can encode and substitutes when it must, because the ffmpeg built here has
libx264 and libass and no libmp3lame, libvpx or libopus: "just the audio as an
mp3" comes back as `.m4a`, a `webm` comes back as `.mp4`, and the substitution
is reported so the assistant says what it actually made. Everything else — mp4,
gif, wav, png, jpg — is byte-identical to the desktop path. Adding the three
libraries to `third_party/ffmpeg/build-ffmpeg-android.sh` would remove even
that difference; see its README for the cost.

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

## Keys

Two are baked at build time exactly as on desktop — the env var wins, else the
repo-root `.env`, else nothing:

| | Baked from | Missing means |
| --- | --- | --- |
| Transcription (ElevenLabs) | `ELEVENLABS_API_KEY` | unavailable unless entered later in the API keys dialog |
| Transcription (Sarvam Saaras v3) | `SARVAM_API_KEY` | unavailable unless entered later in the API keys dialog |
| Image generation | `GEMINI_API_KEY` | the Images panel imports files but cannot generate them |

When both transcription keys are baked, Sarvam is the default automatic-import
provider; the on-import panel lets the user choose ElevenLabs instead. With just
one transcription key, that provider is selected automatically.

**A built APK containing a key is private** — anyone who has it can extract the
key and spend the credit.

Baking is a convenience; the app's own **API keys dialog** is the real path, and
on a phone it is the ONLY one. There is no `.env` to edit and no shell to export
from, so a credential that is not in `MANAGED_KEYS`
(`apps/server/src/settings.ts`) cannot be set on the device at all. Keys entered
there persist to `SETTINGS_PATH` (`filesDir/.jumpcut-secrets.json`) and always
win over a baked value — the bake targets `__BAKED_*` fallbacks, never the live
variable, so it can never freeze a getter (see `apps/server/src/config.ts`).

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
- **Generating an image is the one feature that needs the network.** Everything
  else — cutting, framing, grading, captions, the render — runs offline on the
  phone; a picture is made by Gemini and cannot be. Importing one from the
  gallery works on a plane. Compositing it needs a PNG decoder, so keep
  `--enable-zlib` in the ffmpeg build (`third_party/ffmpeg/README.md`).
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
