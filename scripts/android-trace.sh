#!/bin/bash
# The emulator's logcat, every buffer with when each process starts, dies or is killed, appended to FILE until killed, as
# the Android scenarios run: MISE_ENV=android mise exec -- scripts/android-trace.sh FILE &. Read off the emulator as it
# comes, so that what led up to a kernel panic outlives the reboot that loses the emulator's own buffers; again from the
# last line read when adb drops the connection, or the emulator boots again.
set -uo pipefail
touch "$1"
while :; do
  timeout 120 adb -s 127.0.0.1:5600 wait-for-device > /dev/null 2>&1 || { sleep 5; continue; }
  since=$(tail -n 1 "$1" | grep -o -m1 '^ *[0-9]*\.[0-9]*' | tr -d ' ')
  adb -s 127.0.0.1:5600 logcat -b main,system,crash,events -v threadtime -v epoch ${since:+-T "$since"} >> "$1" 2>&1
  sleep 2
done
