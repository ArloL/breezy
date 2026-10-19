#!/bin/bash
# Builds the platform scenarios' Android keyboard into OUT/ime.apk, without Gradle: tools/breezy-ime/build.sh OUT.
# Needs ANDROID_HOME with build-tools 35.0.0 and platform android-35, which scripts/android.ts installs, and javac.
set -euo pipefail
src=$(cd "$(dirname "$0")" && pwd)
out=$1
bt=$ANDROID_HOME/build-tools/35.0.0
jar=$ANDROID_HOME/platforms/android-35/android.jar
rm -rf "$out" && mkdir -p "$out/classes"
"$bt/aapt2" compile --dir "$src/res" -o "$out/res.zip"
"$bt/aapt2" link "$out/res.zip" -I "$jar" --manifest "$src/AndroidManifest.xml" -o "$out/unsigned.apk" --min-sdk-version 33 --target-sdk-version 35
javac --release 17 -classpath "$jar" -d "$out/classes" "$src/src/de/k5d/breezy/ime/Ime.java"
"$bt/d8" --lib "$jar" --min-api 33 --output "$out" $(find "$out/classes" -name '*.class')
(cd "$out" && zip -q unsigned.apk classes.dex)
"$bt/zipalign" -f 4 "$out/unsigned.apk" "$out/aligned.apk"
# a key of its own each build: the apk is installed on emulators only
keytool -genkeypair -keystore "$out/key.jks" -storepass android -keypass android -alias k -keyalg RSA -dname CN=breezy-ime -validity 1000 >/dev/null 2>&1
"$bt/apksigner" sign --ks "$out/key.jks" --ks-pass pass:android --out "$out/ime.apk" "$out/aligned.apk"
