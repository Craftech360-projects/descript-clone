#!/usr/bin/env bash
#
# Build ffmpeg + ffprobe as Android arm64 PIE *executables* — the pair the app
# spawns, shipped as jniLibs so they install executable into nativeLibraryDir.
#
#   out/libffmpeg.so   → copy to app/src/main/jniLibs/arm64-v8a/
#   out/libffprobe.so  → copy to app/src/main/jniLibs/arm64-v8a/
#
# "lib*.so" naming is deliberate: only files matching lib*.so are installed to
# the app's nativeLibraryDir, which is the one executable-mountable location on
# API 29+ (W^X). They are ordinary ELF executables regardless of the name.
#
# Everything is linked STATICALLY against its deps (x264, libass and friends);
# the only dynamic dependencies of the result are bionic system libs
# (libc/libm/libdl/liblog), which every Android device has. Do not switch the
# deps to shared: a shared libx264.so next to the executable is NOT on the
# linker path when Node spawns it, and it dies with a dlopen error — the exact
# failure mode documented in ffmpeg-android-maker issue #31.
#
# Feature set is driven by what packages/core/src/render.ts emits:
#   libx264 (GPL!)  -preset/-crf H.264 encode
#   aac             audio encode
#   libass + fontconfig/freetype/fribidi/harfbuzz  burned captions ('subtitles' filter)
#   loudnorm, alimiter, atempo, aresample          Studio Sound / speed chains
#   pcm_s16le       ASR extract + waveform peaks
#   zlib            PNG decode — see the image inserts below
# Decoders are left ON (a phone import can be almost anything).
#
# IMAGE INSERTS (packages/core/src/overlay.ts) add a second kind of input: a
# still, read with `-loop 1 -framerate F -t D -i pic.png`, then
# scale/crop/format=rgba/colorchannelmixer/fade and composited with `overlay`.
# Every filter in that chain is built in and needs no configure flag — but the
# DECODE does. Generated images come back from Gemini as PNG, and ffmpeg's PNG
# decoder is useless without zlib, so `--enable-zlib` is passed EXPLICITLY
# below. It is autodetected and would almost certainly be found anyway; the
# point of naming it is that configure then FAILS if it is not, instead of
# quietly producing an ffmpeg that renders every other feature perfectly and
# dies only when someone inserts a picture.
#
# GPL NOTICE: --enable-gpl + libx264 makes the produced binaries — and any APK
# embedding them — GPL-encumbered. Same posture as the desktop builds'
# ffmpeg-static. Fine for private use; constrains public redistribution.
#
# Run on Linux or WSL (macOS works with a Linux NDK swapped in). Needs:
#   - Android NDK r27 (pin: set ANDROID_NDK_HOME)
#   - git, make, nasm/yasm not required (x264 asm is off for simplicity; enable
#     with nasm installed if encode speed matters more than build simplicity)
#   - autoconf/automake/libtool/pkg-config, meson+ninja (harfbuzz/fribidi)
#
# This script is a pinned, reproducible recipe rather than a framework. It
# builds in ./build and leaves results in ./out. Re-runs reuse source clones.

set -euo pipefail

# ── toolchain ─────────────────────────────────────────────────────────────────
: "${ANDROID_NDK_HOME:?Set ANDROID_NDK_HOME to your NDK r27 install}"
API=29
HOST_TAG=linux-x86_64
TOOLCHAIN="$ANDROID_NDK_HOME/toolchains/llvm/prebuilt/$HOST_TAG"
TARGET=aarch64-linux-android

export CC="$TOOLCHAIN/bin/${TARGET}${API}-clang"
export CXX="$TOOLCHAIN/bin/${TARGET}${API}-clang++"
export AR="$TOOLCHAIN/bin/llvm-ar"
export RANLIB="$TOOLCHAIN/bin/llvm-ranlib"
export STRIP="$TOOLCHAIN/bin/llvm-strip"
export PKG_CONFIG_LIBDIR="$PWD/build/prefix/lib/pkgconfig"

ROOT="$PWD"
BUILD="$ROOT/build"
PREFIX="$BUILD/prefix"
OUT="$ROOT/out"
mkdir -p "$BUILD" "$PREFIX" "$OUT"
cd "$BUILD"

JOBS=$(nproc)

clone() { # clone <url> <dir> <ref>
  if [ ! -d "$2" ]; then git clone --depth 1 --branch "$3" "$1" "$2"; fi
}

# ── pinned sources ────────────────────────────────────────────────────────────
clone https://code.videolan.org/videolan/x264.git            x264      stable
clone https://gitlab.freedesktop.org/freetype/freetype.git   freetype  VER-2-13-3
clone https://github.com/fribidi/fribidi.git                 fribidi   v1.0.16
clone https://github.com/harfbuzz/harfbuzz.git               harfbuzz  10.1.0
clone https://github.com/libexpat/libexpat.git               libexpat  R_2_6_4
clone https://gitlab.freedesktop.org/fontconfig/fontconfig.git fontconfig 2.15.0
clone https://github.com/libass/libass.git                   libass    0.17.3
clone https://git.ffmpeg.org/ffmpeg.git                      ffmpeg    n7.1

MESON_CROSS="$BUILD/meson-cross.txt"
cat > "$MESON_CROSS" <<EOF
[binaries]
c = '$CC'
cpp = '$CXX'
ar = '$AR'
strip = '$STRIP'
pkg-config = 'pkg-config'

[host_machine]
system = 'android'
cpu_family = 'aarch64'
cpu = 'aarch64'
endian = 'little'
EOF

# ── x264 ──────────────────────────────────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libx264.a" ]; then
  ( cd x264
    ./configure --host=$TARGET --cross-prefix="$TOOLCHAIN/bin/llvm-" \
      --sysroot="$TOOLCHAIN/sysroot" --prefix="$PREFIX" \
      --enable-static --enable-pic --disable-asm --disable-cli
    make -j"$JOBS" && make install )
fi

# ── freetype (first pass, no harfbuzz) ────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libfreetype.a" ]; then
  ( cd freetype
    meson setup b --cross-file "$MESON_CROSS" --prefix "$PREFIX" \
      --default-library static -Dharfbuzz=disabled -Dbrotli=disabled -Dpng=disabled \
      -Dbzip2=disabled -Dzlib=system
    ninja -C b -j"$JOBS" && ninja -C b install )
fi

# ── fribidi ───────────────────────────────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libfribidi.a" ]; then
  ( cd fribidi
    meson setup b --cross-file "$MESON_CROSS" --prefix "$PREFIX" \
      --default-library static -Ddocs=false -Dtests=false
    ninja -C b -j"$JOBS" && ninja -C b install )
fi

# ── harfbuzz ──────────────────────────────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libharfbuzz.a" ]; then
  ( cd harfbuzz
    meson setup b --cross-file "$MESON_CROSS" --prefix "$PREFIX" \
      --default-library static -Dfreetype=enabled -Dtests=disabled -Ddocs=disabled \
      -Dglib=disabled -Dgobject=disabled -Dcairo=disabled -Dicu=disabled
    ninja -C b -j"$JOBS" && ninja -C b install )
fi

# ── expat (fontconfig dep) ────────────────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libexpat.a" ]; then
  ( cd libexpat/expat
    ./buildconf.sh
    ./configure --host=$TARGET --prefix="$PREFIX" --enable-static --disable-shared \
      --without-docbook --without-examples --without-tests
    make -j"$JOBS" && make install )
fi

# ── fontconfig ────────────────────────────────────────────────────────────────
# libass prefers fontconfig for family lookup; the app also passes an explicit
# fontsdir, but fontconfig lets a family NAME resolve against the fonts the app
# manages. Cache dir comes from XDG_CACHE_HOME, which the shell sets.
if [ ! -f "$PREFIX/lib/libfontconfig.a" ]; then
  ( cd fontconfig
    meson setup b --cross-file "$MESON_CROSS" --prefix "$PREFIX" \
      --default-library static -Ddoc=disabled -Dtests=disabled -Dtools=disabled \
      -Dcache-build=disabled
    ninja -C b -j"$JOBS" && ninja -C b install )
fi

# ── libass ────────────────────────────────────────────────────────────────────
if [ ! -f "$PREFIX/lib/libass.a" ]; then
  ( cd libass
    ./autogen.sh
    ./configure --host=$TARGET --prefix="$PREFIX" --enable-static --disable-shared \
      --disable-asm
    make -j"$JOBS" && make install )
fi

# ── ffmpeg + ffprobe ──────────────────────────────────────────────────────────
( cd ffmpeg
  ./configure \
    --target-os=android --arch=aarch64 --cpu=armv8-a \
    --cc="$CC" --cxx="$CXX" --ar="$AR" --ranlib="$RANLIB" --strip="$STRIP" \
    --sysroot="$TOOLCHAIN/sysroot" \
    --prefix="$PREFIX" \
    --pkg-config=pkg-config --pkg-config-flags=--static \
    --enable-cross-compile --enable-pic \
    --disable-shared --enable-static \
    --disable-doc --disable-debug --disable-symver \
    --disable-avdevice --disable-postproc \
    --enable-gpl --enable-libx264 \
    --enable-libass --enable-libfreetype --enable-libfribidi --enable-libharfbuzz \
    --enable-libfontconfig \
    --enable-zlib \
    --extra-cflags="-fPIC" --extra-ldflags="-pie" \
    --extra-libs="-lm"
  make -j"$JOBS"
  cp ffmpeg  "$OUT/libffmpeg.so"
  cp ffprobe "$OUT/libffprobe.so"
  "$STRIP" "$OUT/libffmpeg.so" "$OUT/libffprobe.so" )

echo
echo "✓ built:"
ls -lh "$OUT"
echo
echo "Sanity: dynamic deps must be bionic-only (libc/libm/libdl/liblog):"
"$TOOLCHAIN/bin/llvm-readelf" -d "$OUT/libffmpeg.so" | grep NEEDED || true
echo
echo "Install: cp out/libff*.so ../../app/src/main/jniLibs/arm64-v8a/"
