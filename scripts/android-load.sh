#!/bin/bash
# What the runner and the emulator are busy with, every 10 s, appended to FILE until killed, as the Android scenarios run:
# MISE_ENV=android mise exec -- scripts/android-load.sh FILE &. A flake on a starved runner shows here.
set -uo pipefail
while sleep 10; do
  date -u +%T
  uptime
  free -m | head -n 2
  timeout 5 adb -s 127.0.0.1:5600 shell top -b -n 1 -m 8 2>&1 | tail -n 9
done >> "$1" 2>&1
