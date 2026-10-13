#!/bin/zsh
# Boots a headless Pixel 8a emulator whose Chrome Playwright can drive, for the scenarios' android device:
#   MISE_ENV=android mise install && MISE_ENV=android mise exec -- scripts/android.sh
# Installs the system image and creates the AVD the first time. Stop it with adb emu kill.
set -e
image="system-images;android-36;google_apis_playstore;${${$(uname -m):s/arm64/arm64-v8a/}:s/aarch64/arm64-v8a/}"
if [[ ! -x $ANDROID_HOME/emulator/emulator || ! -d $ANDROID_HOME/${image//;//} ]]; then
  yes | sdkmanager --licenses >/dev/null
  sdkmanager emulator platform-tools $image >/dev/null
fi
if [[ ! -f $ANDROID_AVD_HOME/breezy.ini ]]; then
  # avdmanager writes elsewhere when the directory is missing
  mkdir -p $ANDROID_AVD_HOME
  print no | avdmanager create avd --name breezy --package $image --device pixel_8a >/dev/null
fi
if ! adb devices | grep -q '^emulator-'; then
  mkdir -p ${0:A:h:h}/build
  $ANDROID_HOME/emulator/emulator -avd breezy -no-window -no-audio -no-boot-anim -no-snapshot-save >${0:A:h:h}/build/android-emulator.log 2>&1 &!
fi
adb wait-for-device
until [[ $(adb shell getprop sys.boot_completed 2>/dev/null) == 1* ]]; do sleep 1; done
# a user build's Chrome reads the command line Playwright writes only as the debug app
adb shell am set-debug-app --persistent com.android.chrome
# else Chrome asks for it over the page
adb shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS
# Chrome's first-run screens, which Playwright's --disable-fre does not skip
adb shell am start -W -n com.android.chrome/com.google.android.apps.chrome.Main >/dev/null
for i in {1..10}; do
  sleep 2
  ui=$(adb shell 'uiautomator dump /sdcard/ui.xml >/dev/null && cat /sdcard/ui.xml')
  [[ $ui =~ "com.android.chrome:id/(url_bar|search_box_text)" ]] && break
  b=($(print -r -- $ui | grep -oE 'text="(Use without an account|No thanks|Got it)"[^>]*bounds="[^"]*"' | head -1 | grep -oE '[0-9]+' | tail -4))
  (( $#b == 4 )) && adb shell input tap $(( (b[1] + b[3]) / 2 )) $(( (b[2] + b[4]) / 2 ))
done
