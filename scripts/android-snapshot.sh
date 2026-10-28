#!/bin/bash
# The emulator's AVD with its snapshot breezy-ready (scripts/android.ts), and the adb key it trusts, as one file for
# CI's cache: each runner's adb makes its own key, which the AVD, booted from its snapshot or cold, refused as
# unauthorized. zstd with long matching, which at level 19 packed an AVD of 8.5 GB into 4.9 GB, smaller than xz's 5.2,
# and unpacked it in 5 s; at level 12, as level 19 took 341 s on a 10-core Mac and a CI runner has 4.
#   MISE_ENV=android mise exec -- scripts/android-snapshot.sh unpack FILE   the AVD from FILE, if there is one
#   MISE_ENV=android mise exec -- scripts/android-snapshot.sh pack FILE     the AVD into FILE, the emulator stopped for
#                                                                           it and booted again from its snapshot
set -euo pipefail
what=$1 file=$2
avd=breezy-android-37.0
keys=${ANDROID_USER_HOME:-$HOME/.android}
case $what in
unpack)
  [ -f "$file" ] || exit 0
  mkdir -p "$ANDROID_AVD_HOME"
  zstd -d --long=31 -q -c "$file" | tar -C "$ANDROID_AVD_HOME" -xf -
  rm "$file"
  if [ -f "$ANDROID_AVD_HOME/adbkey" ]; then
    mkdir -p "$keys"
    mv "$ANDROID_AVD_HOME/adbkey" "$ANDROID_AVD_HOME/adbkey.pub" "$keys/"
    # a server started before holds the key it read then
    timeout 30 adb kill-server > /dev/null 2>&1 || true
  fi
  ;;
pack)
  # a disk the emulator writes to as it is packed would load as neither then nor now
  timeout 30 adb emu kill > /dev/null 2>&1 || true
  for _ in $(seq 1 60); do pgrep -f "qemu-system-.* -avd " > /dev/null || break; sleep 1; done
  pkill -KILL -f "qemu-system-.* -avd " 2> /dev/null || true
  tar -C "$ANDROID_AVD_HOME" -cf - "$avd.avd" "$avd.ini" -C "$keys" adbkey adbkey.pub | zstd -T0 -12 --long=31 -q -o "$file"
  ls -l "$file"
  echo "packed in $SECONDS s"
  scripts/android-boot.sh
  ;;
*)
  echo "usage: $0 unpack|pack FILE" >&2
  exit 2
  ;;
esac
