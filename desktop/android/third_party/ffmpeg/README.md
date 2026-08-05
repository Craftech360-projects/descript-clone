# ffmpeg / ffprobe for Android

The app spawns real `ffmpeg`/`ffprobe` executables, exactly as the desktop
builds do — nothing is rewritten against a library API. Android just makes two
demands the desktop doesn't:

1. **They must be bionic binaries.** The glibc static builds that
   `ffmpeg-static` ships (and the johnvansickle builds) do not run on Android.
   ffmpeg-kit is retired and its prebuilts were removed; Termux packages link
   against the Termux prefix. So we build our own — `build-ffmpeg-android.sh`,
   run in WSL/Linux with NDK r27.
2. **They must live in `nativeLibraryDir` to be executable.** API 29+ enforces
   W^X: nothing under the app's writable storage can be exec()d. Files named
   `lib*.so` inside `jniLibs/<abi>/` are installed by the OS into
   `applicationInfo.nativeLibraryDir`, which IS executable — hence the odd
   names `libffmpeg.so`/`libffprobe.so` for what are ordinary ELF executables.
   (`jniLibs.useLegacyPackaging = true` in gradle + `extractNativeLibs="true"`
   in the manifest force real files rather than APK-mapped pages.)

## Build

```bash
export ANDROID_NDK_HOME=/path/to/ndk/27.x
./build-ffmpeg-android.sh
cp out/libffmpeg.so out/libffprobe.so ../../app/src/main/jniLibs/arm64-v8a/
```

The script verifies the result's dynamic deps are bionic system libraries only
(`libc/libm/libdl`). If you see anything else in the NEEDED list, a dep slipped
into shared linkage — fix that rather than shipping it, or the spawn dies with
a dlopen error on-device (the failure mode ffmpeg-android-maker's issue #31
documents).

Static-linking *bionic itself* is deliberately not attempted: it is unsupported
by the NDK and unnecessary — every device has the system libs.

## Licensing — read before distributing

The build uses `--enable-gpl --enable-libx264`: the binaries, and any APK that
embeds them, are **GPL-encumbered**. This mirrors the desktop builds, whose
`ffmpeg-static` is also a GPL build (see desktop/README.md). Private use
between known users: a non-issue. Public distribution: constrained — worth
resolving (LGPL build with a different H.264 encoder, e.g. mediacodec) before
this ever ships widely.

## Feature set

Chosen from what `packages/core/src/render.ts` actually emits: libx264 + aac
encode, `subtitles` filter (libass + freetype/fribidi/harfbuzz/fontconfig) for
burned captions, `loudnorm`/`alimiter`/`atempo`/`aresample` for the audio
chains, `pcm_s16le` for ASR extraction and waveform peaks. Decoders are left
fully enabled — a phone import can be almost anything. A size-trim pass
(disabling unused demuxers/encoders) is a ship-time optimization, not a
starting point.
