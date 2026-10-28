// scripts/android-snapshot.sh, its emulator and adb stubbed: the AVD it packs on one runner boots on another.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../android-snapshot.sh", import.meta.url));

test("an AVD packed on one runner is trusted by the adb of another, which made its own key", () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-snapshot-"));
  try {
    // adb, pgrep and pkill do nothing, and the boot after packing is the cwd's
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const cmd of ["adb", "pgrep", "pkill"]) {
      writeFileSync(join(bin, cmd), `#!/bin/sh\n${cmd === "pgrep" ? "exit 1" : "exit 0"}\n`);
      chmodSync(join(bin, cmd), 0o755);
    }
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "android-boot.sh"), "#!/bin/sh\n");
    chmodSync(join(dir, "scripts", "android-boot.sh"), 0o755);
    /** A runner's home, its AVD, and its adb's key, which adb makes on its first start. */
    const runner = (name: string, key: string) => {
      const home = join(dir, name), avds = join(home, ".android", "avd");
      mkdirSync(join(avds, "breezy-android-37.0.avd"), { recursive: true });
      writeFileSync(join(home, ".android", "adbkey"), `${key} private`);
      writeFileSync(join(home, ".android", "adbkey.pub"), `${key} public`);
      return { HOME: home, ANDROID_AVD_HOME: avds };
    };
    const run = (env: Record<string, string>, ...args: string[]) =>
      execFileSync(script, args, { cwd: dir, env: { ...process.env, ...env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
    const saver = runner("saver", "A");
    writeFileSync(join(saver.ANDROID_AVD_HOME, "breezy-android-37.0.ini"), "");
    writeFileSync(join(saver.ANDROID_AVD_HOME, "breezy-android-37.0.avd", "userdata-qemu.img"), "trusts A");
    run(saver, "pack", join(dir, "avd.tar.zst"));

    const restorer = runner("restorer", "B");
    rmSync(join(restorer.ANDROID_AVD_HOME, "breezy-android-37.0.avd"), { recursive: true });
    run(restorer, "unpack", join(dir, "avd.tar.zst"));
    assert.equal(readFileSync(join(restorer.ANDROID_AVD_HOME, "breezy-android-37.0.avd", "userdata-qemu.img"), "utf8"), "trusts A");
    assert.equal(readFileSync(join(restorer.HOME, ".android", "adbkey"), "utf8"), "A private");
    assert.equal(readFileSync(join(restorer.HOME, ".android", "adbkey.pub"), "utf8"), "A public");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
