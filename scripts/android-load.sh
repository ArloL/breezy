#!/bin/bash
# What the runner and the emulator are busy with, every 10 s, appended to FILE until killed, as the Android scenarios run:
# MISE_ENV=android mise exec -- scripts/android-load.sh FILE &. A flake on a starved runner shows here, and the emulator's
# uptime beside the time places its kernel's lines, which count from its boot, on the wall clock.
set -uo pipefail
while sleep 10; do
  date -u +%T
  echo "emulator up $(timeout 5 adb -s 127.0.0.1:5600 shell cat /proc/uptime 2>&1 | cut -d ' ' -f 1) s"
  uptime
  free -m | head -n 2
  timeout 5 adb -s 127.0.0.1:5600 shell top -b -n 1 -m 8 2>&1 | tail -n 9
done >> "$1" 2>&1
