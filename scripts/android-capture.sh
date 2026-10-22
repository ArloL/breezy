#!/bin/bash
# What the emulator and the runner were doing, into OUT, once the Android scenarios failed or ended, on a Linux runner:
# MISE_ENV=android mise exec -- scripts/android-capture.sh OUT. Each adb call is bounded, as adb waits without end on a
# wedged emulator, and none fails the script.
set -uo pipefail
out=$1
mkdir -p "$out"
# the emulator by its console's serial: adb counts adbd over TCP on 127.0.0.1 as one too; none once it has died
serial=$(timeout 20 adb devices | grep -o -m1 "^emulator-[0-9]*")
if [[ -n $serial ]]; then
  on() { timeout 20 adb -s "$serial" "$@"; }
  on exec-out screencap -p > "$out/android-screen.png"
  on logcat -d -b all > "$out/android-logcat.txt"
  # which window has focus and whether the keyboard is up: a keyboard coming up over Firefox once wedged the display
  on shell dumpsys window windows > "$out/android-windows.txt"
  on shell dumpsys input_method > "$out/android-ime.txt"
  on shell dumpsys SurfaceFlinger > "$out/android-surfaceflinger.txt"
  on shell dumpsys meminfo > "$out/android-meminfo.txt"
  on shell top -b -n 1 > "$out/android-top.txt"
fi
{ pgrep -a qemu || echo "no emulator running"; uptime; free -m; ps -eo pid,pcpu,pmem,etime,args --sort=-pcpu | head -n 20; sudo dmesg | tail -n 50; } > "$out/android-host.txt" 2>&1
cp /tmp/adb.*.log "$out/" 2>/dev/null
exit 0
