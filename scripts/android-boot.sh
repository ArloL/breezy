#!/bin/bash
# Boots the emulator as scripts/android.ts does, and once more from scratch when that fails: in a soak, 2 of 20 boots
# gave up, one on Chrome's first run, one on adbd listening on TCP. MISE_ENV=android mise exec -- scripts/android-boot.sh
set -uo pipefail
node scripts/android.ts && exit 0
echo "::warning title=Emulator boot::the first boot failed; booting once more"
timeout 30 adb emu kill > /dev/null 2>&1
sleep 5
pkill -KILL -f "qemu-system-.* -avd " 2> /dev/null
timeout 30 adb kill-server > /dev/null 2>&1
# the failed boot's log, which the next one starts afresh
[ -f build/android-emulator.log ] && mv build/android-emulator.log "build/android-emulator-failed-boot.log"
node scripts/android.ts
