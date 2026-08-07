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
chains, `pcm_s16le` for ASR extraction and waveform peaks, and **zlib** for PNG
decode. Decoders are left fully enabled — a phone import can be almost anything.

zlib is the one that is easy to lose. Image inserts (`packages/core/src/overlay.ts`)
feed a still in as a second input — `-loop 1 -framerate F -t D -i pic.png` —
and generated images arrive as PNG, which ffmpeg cannot decode without it. Every
filter in that chain (`scale`, `crop`, `format`, `colorchannelmixer`, `fade`,
`overlay`) is built in and costs no flag; the decoder is the only part with a
dependency. The script passes `--enable-zlib` explicitly so a missing zlib stops
the build rather than producing an ffmpeg that fails only on the one feature.

A size-trim pass (disabling unused demuxers/encoders) is a ship-time
optimization, not a starting point — and when someone does it, `image2` plus the
png/mjpeg/webp decoders have to survive it.

## What the assistant's escape hatch does without

`apps/server/src/summon.ts` is the one module that reaches past the render's
codec set: it lets the assistant produce a gif, a still, an audio-only extract —
media the editor itself never writes. It does not assume anything is here. It
asks the binary (`ffmpeg -encoders`, once per process) and substitutes what this
build can actually do:

| asked for | this build | why |
| --- | --- | --- |
| `mp3` | `.m4a`, AAC | ffmpeg has **no native mp3 encoder** — it is libmp3lame or libshine or nothing |
| `webm` | `.mp4`, H.264 | VP8/VP9 and Opus are the only codecs a .webm may carry |
| mp4, gif, wav, png, jpg | as asked | x264, and the gif/png/mjpeg/pcm encoders every build has |

Adding `--enable-libmp3lame --enable-libvpx --enable-libopus` (and the three
cross-compiled libraries above ffmpeg in the script) removes the substitution.
libvpx is the expensive one — a slow build and a few MB of binary — for a
container Android's own player handles worse than mp4. The substitution is the
better default; the flags are here if the difference ever matters.

One thing the escape hatch deliberately does NOT need: `-f lavfi`. Turning a
still into a video wants a silent audio track, and the obvious spelling of that
is `-f lavfi -i anullsrc`, which is the **lavfi input device** — libavdevice,
which this build disables. `summon.ts` uses `anullsrc` as a filter source inside
`-filter_complex` instead: identical silence, from libavfilter, which is always
built. If `--disable-avdevice` ever gets dropped, leave that alone anyway; it is
the more portable of the two.
