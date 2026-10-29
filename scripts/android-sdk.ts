// What scripts/android.ts installs into the SDK, which CI's SDK cache is keyed on: with the whole script in its key, each
// change to the script saved another 3 GB entry.
import { arch } from "node:os";

/** Android 17 with Google Play, whose Chrome is the one a phone gets; the AVD is named for it, so a new one replaces it */
export const API = "android-37.0";
export const IMAGE = `system-images;${API};google_apis_playstore;${arch() === "arm64" ? "arm64-v8a" : "x86_64"}`;
/** with build-tools and the platform build tools/breezy-ime, the keyboard the platform rows type with */
export const PACKAGES = ["emulator", "platform-tools", IMAGE, "build-tools;35.0.0", "platforms;android-35"];
/** The Firefox for Android scripts/android.ts installs, its APK kept in the SDK's folder. */
export const FENIX_VERSION = "157.0.1";
