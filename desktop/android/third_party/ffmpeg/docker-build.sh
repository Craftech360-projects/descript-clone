#!/usr/bin/env bash
# Driver for running build-ffmpeg-android.sh inside a plain ubuntu:24.04
# container on a Windows host (no WSL distro needed). Mount this directory at
# /host; results land back in ./out/ on the host.
#
#   docker run --name ffbuild -v <this dir>:/host ubuntu:24.04 \
#     bash -c "tr -d '\r' < /host/docker-build.sh > /tmp/b.sh && bash /tmp/b.sh"
#
# The build itself runs in the container's own filesystem (/root/ffwork) —
# compiling on the Windows bind mount would be painfully slow — and only the
# two final binaries are copied back out.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -q
apt-get install -yq git make curl unzip ca-certificates \
  autoconf automake libtool pkg-config meson ninja-build gperf python3

if [ ! -d /opt/android-ndk-r27c ]; then
  echo "== downloading NDK r27c =="
  curl -fsSL -o /tmp/ndk.zip https://dl.google.com/android/repository/android-ndk-r27c-linux.zip
  unzip -q /tmp/ndk.zip -d /opt
  rm /tmp/ndk.zip
fi
export ANDROID_NDK_HOME=/opt/android-ndk-r27c

mkdir -p /root/ffwork
cp /host/build-ffmpeg-android.sh /root/ffwork/
sed -i 's/\r$//' /root/ffwork/build-ffmpeg-android.sh
cd /root/ffwork
bash build-ffmpeg-android.sh

mkdir -p /host/out
cp out/libffmpeg.so out/libffprobe.so /host/out/
echo "== DOCKER BUILD DONE =="
