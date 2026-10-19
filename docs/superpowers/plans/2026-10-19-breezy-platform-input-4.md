# Platform input, part 4: Android — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Test the Android rows of `docs/platform-expectations.md` that a keyboard's calls into Chrome decide (A1, A2, A3, A7, A10, A12, C1, D7, F1, F2) through Android's own input method channel on the emulator, keep what Chrome sent as traces that replay on every push, and fix what fails.

**Architecture:** `tools/breezy-ime` is an Android input method built in the repo. It makes the `InputConnection` calls a keyboard makes, on command from `adb shell am broadcast`. `scenarios/platform/android.e2e.ts` opens the web app in Chrome on the emulator, opens a card's editor with a real touch so that the keyboard starts, records a trace with `web/record.ts`, and checks the row. `scenarios/platform/harness.ts` holds what the Mac and Android runs share. Traces under `scenarios/traces/android/` replay through the existing `replay.test.ts`.

**Tech Stack:** Java 17 against `android.jar` 35, built with `aapt2`, `d8`, `zipalign` and `apksigner` (no Gradle); TypeScript on Node 24 with `node:test`; playwright-core 1.64.0's `_android`.

**Spec:** `docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md` (see Spike results, row 3)

Rows left for a later part: B3 (needs a content provider in the input method), D11 and D12 (lane titles and hardware keys), the E and G rows, and real Gboard's emoji tab.

## Global Constraints

- Target: `android`, Chrome on the emulator `scripts/android.ts` boots, reached over `EMULATOR_TCP` (`127.0.0.1:5600`).
- An editor's keyboard starts only after a real touch through the emulator's touchscreen; DevTools focus alone makes the input method's text arrive as keyCode 229 and insert nothing (spike 3).
- The emulator's default keyboard is put back after a run, also when it fails or is interrupted.
- A row's replay checks the row's `expect`, never the trace's recorded `after`. A trace recorded while a bug happens is recorded again natively once fixed.
- A failing row is a `todo` test until its fix lands; CI stays green.
- Pages are served on `WEB` (58565), a port `scripts/android.ts` reserves on the emulator.
- Node ≥ 24, `playwright-core` 1.64.0, build-tools 35.0.0, platform `android-35`, Java 21 (from `mise.android.toml`) compiling `--release 17`.
- Code reads like the surrounding code: few comments, each saying why. Commit messages are sentences saying what changed for a person, ending with the `Claude-Session:` line.

## Review Focus

1. Text with spaces or quotes in an `adb shell am broadcast` extra is split by the device's shell: every extra is quoted (Task 2).
2. A run interrupted with ⌃C leaves the emulator typing through `breezy-ime`: the default keyboard is restored on exit and on SIGINT (Task 3).
3. A rotated emulator left rotated breaks the next touch scenario's coordinates: F2 restores rotation in `finally` (Task 4).
4. `setComposingRegion` offsets count UTF-16 units of the editor's text as Chrome sees it, newline included: A12 picks its offsets from the trace's `before`, not from constants (Task 4).
5. Chrome on Android launching without opening DevTools, as `RealWorld.android` works around: the harness launches through the same function (Task 3).

---

### Task 1: The test input method in the repo

**Files:**
- Create: `tools/breezy-ime/AndroidManifest.xml`
- Create: `tools/breezy-ime/res/xml/method.xml`
- Create: `tools/breezy-ime/src/de/k5d/breezy/ime/Ime.java`
- Create: `tools/breezy-ime/build.sh`
- Modify: `scripts/android.ts` (install `build-tools;35.0.0` and `platforms;android-35`)

**Interfaces:**
- Produces: `tools/breezy-ime/build.sh OUT` writes `OUT/ime.apk`. The input method `de.k5d.breezy.ime/.Ime` takes broadcasts `-a de.k5d.breezy.ime.OP` with `op` one of `compose` (`text`), `commit` (`text`), `finish`, `region` (`start`, `end`), `delete` (`before`, `after`), `select` (`start`, `end`), `key` (`code`).

- [ ] **Step 1: Install the build tools with the emulator**

In `scripts/android.ts`, change the install condition and list:
```ts
const tools = ["build-tools;35.0.0", "platforms;android-35"];
if (!existsSync(join(sdk, "emulator", "emulator")) || !existsSync(join(sdk, ...image.split(";"))) || !tools.every((t) => existsSync(join(sdk, ...t.split(";"))))) {
  run("sdkmanager", ["emulator", "platform-tools", image, ...tools], { timeout: 0 });
}
```
and above it, a comment line: `// build-tools and the platform build tools/breezy-ime, the keyboard the platform rows type with`.

- [ ] **Step 2: Write the input method**

`tools/breezy-ime/AndroidManifest.xml`:
```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="de.k5d.breezy.ime">
  <application android:label="Breezy IME">
    <service android:name=".Ime" android:permission="android.permission.BIND_INPUT_METHOD" android:exported="true">
      <intent-filter><action android:name="android.view.InputMethod"/></intent-filter>
      <meta-data android:name="android.view.im" android:resource="@xml/method"/>
    </service>
  </application>
</manifest>
```
`tools/breezy-ime/res/xml/method.xml`:
```xml
<input-method xmlns:android="http://schemas.android.com/apk/res/android"/>
```
`tools/breezy-ime/src/de/k5d/breezy/ime/Ime.java`:
```java
package de.k5d.breezy.ime;

import android.content.*;
import android.inputmethodservice.InputMethodService;
import android.view.*;
import android.view.inputmethod.*;

/**
 * A keyboard for the platform scenarios: each broadcast makes one InputConnection call, as a real keyboard makes it.
 * adb shell am broadcast -a de.k5d.breezy.ime.OP --es op compose --es text に
 */
public class Ime extends InputMethodService {
  private final BroadcastReceiver rx = new BroadcastReceiver() {
    @Override public void onReceive(Context c, Intent i) {
      InputConnection ic = getCurrentInputConnection();
      if (ic == null) return;
      String text = i.getStringExtra("text");
      switch (i.getStringExtra("op")) {
        case "compose": ic.setComposingText(text, 1); break;
        case "commit": ic.commitText(text, 1); break;
        case "finish": ic.finishComposingText(); break;
        case "region": ic.setComposingRegion(i.getIntExtra("start", 0), i.getIntExtra("end", 0)); break;
        case "delete": ic.deleteSurroundingText(i.getIntExtra("before", 1), i.getIntExtra("after", 0)); break;
        case "select": ic.setSelection(i.getIntExtra("start", 0), i.getIntExtra("end", 0)); break;
        case "key": {
          int code = i.getIntExtra("code", KeyEvent.KEYCODE_ENTER);
          ic.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, code));
          ic.sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, code));
          break;
        }
      }
    }
  };

  @Override public void onCreate() {
    super.onCreate();
    registerReceiver(rx, new IntentFilter("de.k5d.breezy.ime.OP"), RECEIVER_EXPORTED);
  }

  @Override public void onDestroy() {
    unregisterReceiver(rx);
    super.onDestroy();
  }

  /** As tall as a phone's keyboard, so that the page makes room for it as it does for one. */
  @Override public View onCreateInputView() {
    View v = new View(this);
    v.setMinimumHeight(700);
    v.setBackgroundColor(0xff202124);
    return v;
  }
}
```

- [ ] **Step 3: Write the build script**

`tools/breezy-ime/build.sh`:
```bash
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
```
Run: `chmod +x tools/breezy-ime/build.sh`.

- [ ] **Step 4: Build and install it by hand**

Run:
```bash
MISE_ENV=android mise exec -- node scripts/android.ts
MISE_ENV=android mise exec -- tools/breezy-ime/build.sh build/breezy-ime
MISE_ENV=android mise exec -- adb -s 127.0.0.1:5600 install -r build/breezy-ime/ime.apk
MISE_ENV=android mise exec -- adb -s 127.0.0.1:5600 shell ime list -s
```
Expected: `Success` from install, and `de.k5d.breezy.ime/.Ime` in the list. Then `adb -s 127.0.0.1:5600 uninstall de.k5d.breezy.ime`.

- [ ] **Step 5: Commit**

```bash
git add tools/breezy-ime scripts/android.ts
git commit --message "Build an Android keyboard for the platform scenarios that makes a real keyboard's calls into Chrome on command, and install what builds it with the emulator" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 2: Rows typed per target, and the shared harness

**Files:**
- Create: `scenarios/platform/harness.ts`
- Create: `scenarios/platform/harness.test.ts`
- Modify: `scenarios/platform/rows.ts` (`Native` → `MacNative`, add `AndroidNative`, type `native` per target)
- Modify: `scenarios/platform/native.e2e.ts` (use `MacNative` and `runRow`)

**Interfaces:**
- Consumes: `Trace`, `EditorState` from `web/record.ts`; `Row`, `Target` from `rows.ts`.
- Produces (`rows.ts`): `interface MacNative { pid: number; oskeys(args: string[]): string; wait(ms: number): Promise<void> }`; `interface AndroidNative { ime(op: string, extras?: Record<string, string | number>): void; adb(...args: string[]): string; text(): Promise<string>; wait(ms: number): Promise<void> }`; `interface Natives { mac: MacNative; "firefox-mac": MacNative; android: AndroidNative }`; `Row.native: { [T in Target]?: (n: Natives[T]) => Promise<void> }`.
- Produces (`harness.ts`): `broadcastArgs(op: string, extras: Record<string, string | number>): string[]`; `runRow(page: Page, row: Row, target: Target, keyboard: string, drive: () => Promise<void>): Promise<Trace>` (records, writes `build/platform/<row>-<variant>-<target>.json` and with `RECORD=1` `scenarios/traces/<target>/<row>-<variant>.json`, and returns the trace).

- [ ] **Step 1: Write the failing test**

`scenarios/platform/harness.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { broadcastArgs } from "./harness.ts";

test("a broadcast quotes each extra for the device's shell", () => {
  assert.deepEqual(broadcastArgs("commit", { text: "hello world" }),
    ["shell", "am", "broadcast", "-a", "de.k5d.breezy.ime.OP", "--es", "op", "'commit'", "--es", "text", "'hello world'"]);
  assert.deepEqual(broadcastArgs("commit", { text: "it's" }).at(-1), "'it'\\''s'");
  assert.deepEqual(broadcastArgs("region", { start: 3, end: 9 }).slice(-6), ["--ei", "start", "3", "--ei", "end", "9"]);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scenarios/platform/harness.test.ts`
Expected: FAIL, `Cannot find module './harness.ts'`.

- [ ] **Step 3: Write the harness**

`scenarios/platform/harness.ts`:
```ts
// What a native run of a row does on any target: open the demo card's editor with ?record, record what the target's
// own input does, keep the trace, and hand it back for the row's check.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import type { Row, Target } from "./rows.ts";
import type { Trace } from "../../web/record.ts";

const root = new URL("../..", import.meta.url).pathname;

/** adb's arguments for one call of tools/breezy-ime; the device's shell splits what it is given, so each value is quoted. */
export function broadcastArgs(op: string, extras: Record<string, string | number>): string[] {
  const quote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
  const args = ["shell", "am", "broadcast", "-a", "de.k5d.breezy.ime.OP", "--es", "op", quote(op)];
  for (const [k, v] of Object.entries(extras)) args.push(typeof v === "number" ? "--ei" : "--es", k, typeof v === "number" ? String(v) : quote(v));
  return args;
}

/** Records `drive` acting on the editor `page` has open, keeps the trace, and returns it. */
export async function runRow(page: Page, row: Row, target: Target, keyboard: string, drive: () => Promise<void>): Promise<Trace> {
  await page.evaluate(([row, variant, target, keyboard]) => (window as any).breezyRecord.start({ row, variant, target, source: "native", keyboard }), [row.id, row.variant, target, keyboard]);
  await drive();
  const trace: Trace = await page.evaluate(() => (window as any).breezyRecord.stop());
  const name = `${row.id}-${row.variant}`;
  mkdirSync(join(root, "build/platform"), { recursive: true });
  writeFileSync(join(root, "build/platform", `${name}-${target}.json`), JSON.stringify(trace, null, 2));
  if (process.env.RECORD) {
    mkdirSync(join(root, "scenarios/traces", target), { recursive: true });
    writeFileSync(join(root, "scenarios/traces", target, `${name}.json`), JSON.stringify(trace, null, 2) + "\n");
  }
  return trace;
}
```

- [ ] **Step 4: Type the rows per target**

In `scenarios/platform/rows.ts`, replace the `Native` interface with:
```ts
/** A Mac target's own input, for a row's native steps. */
export interface MacNative {
  /** The process under test, frontmost. */
  pid: number;
  /** tools/oskeys, refusing unless `pid` is frontmost. */
  oskeys(args: string[]): string;
  wait(ms: number): Promise<void>;
}

/** Android's own input: tools/breezy-ime's calls into the editor that a real touch opened, and adb. */
export interface AndroidNative {
  ime(op: string, extras?: Record<string, string | number>): void;
  adb(...args: string[]): string;
  /** The editor's text as the page has it, for offsets a keyboard counts in it. */
  text(): Promise<string>;
  wait(ms: number): Promise<void>;
}

export interface Natives {
  mac: MacNative;
  "firefox-mac": MacNative;
  android: AndroidNative;
}
```
and in `Row`, replace the `native` line with:
```ts
  native: { [T in Target]?: (n: Natives[T]) => Promise<void> };
```
Replace `(n: Native)` in `japanese` with `(n: MacNative)`.

- [ ] **Step 5: Use the harness in the Mac run**

In `scenarios/platform/native.e2e.ts`, import `runRow` from `./harness.ts` and `type MacNative` from `./rows.ts` instead of `Native`, and replace everything from `await page.evaluate(([row, variant, keyboard]) => …breezyRecord.start…` through the `if (process.env.RECORD) { … }` block with:
```ts
    const n: MacNative = { pid, oskeys: (args) => oskeys(args, pid), wait: sleep };
    const trace = await runRow(page, row, "firefox-mac", keyboard, async () => {
      try {
        await drive(n);
      } finally {
        oskeys(["source", ABC]);
      }
    });
```
Remove the now unused `mkdirSync`, `writeFileSync`, `Trace` imports.

- [ ] **Step 6: Run the tests and the check**

Run: `node --test scenarios/platform/harness.test.ts scenarios/platform/rows.test.ts && npm run check`
Expected: all pass; no type errors. Then `node --test scenarios/platform/native.e2e.ts` (takes over the Mac for a minute); expected: 5 pass.

- [ ] **Step 7: Commit**

```bash
git add scenarios/platform/harness.ts scenarios/platform/harness.test.ts scenarios/platform/rows.ts scenarios/platform/native.e2e.ts
git commit --message "Share recording a row's run between targets, and give each target's rows its own kind of input" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 3: The Android run

**Files:**
- Modify: `scenarios/browser.ts` (export `launchAndroidChrome` from `RealWorld.android`'s launch)
- Create: `scenarios/platform/android.e2e.ts`
- Modify: `.github/workflows/main.yaml` (android job: run it)

**Interfaces:**
- Consumes: `broadcastArgs`, `runRow` (Task 2); `buildSite`, `serveStatic`, `EmulatorConsole`, `Touchscreen`, `EMULATOR_TCP`, `WEB` (`scenarios/browser.ts`); `rows`, `AndroidNative`.
- Produces (`scenarios/browser.ts`): `launchAndroidChrome(device: AndroidDevice): Promise<BrowserContext>`, Chrome launched with the 30 s stall retry `RealWorld.android` has.

- [ ] **Step 1: Extract Chrome's launch**

In `scenarios/browser.ts`, move the `launch`/`again` lines of `RealWorld.android` into:
```ts
/** Chrome on `device`, launched again once if it stalls without opening DevTools, as it does now and then; why is not known. */
export async function launchAndroidChrome(device: AndroidDevice): Promise<BrowserContext> {
  const launch = () => Promise.race([device.launchBrowser({ reducedMotion: "reduce", hasTouch: true }), sleep(30_000).then(() => null)]);
  const again = () => {
    globalThis.console.log("Chrome did not open DevTools in 30 s: launching it again");
    return launch();
  };
  const context = await launch() ?? await again();
  if (!context) throw new Error("Chrome did not launch twice in 30 s");
  return context;
}
```
and in `RealWorld.android`: `const context = opened[1] = await launchAndroidChrome(device);`. Keep the comment about force-stopping that sat above the old lines with the new function. Run `npm run check`; expected: no errors. `hasTouch` is new for `RealWorld`; run `MISE_ENV=android mise exec -- node --test --test-name-pattern "android" scenarios/browsers.e2e.ts` and expect it to pass as before. If it fails because of `hasTouch`, pass `hasTouch` only from the platform run.

- [ ] **Step 2: Write the Android run**

`scenarios/platform/android.e2e.ts`:
```ts
// Each row through Android's own input: Chrome on the emulator, with tools/breezy-ime as its keyboard making the calls
// a keyboard makes. A real touch opens each editor's keyboard, which DevTools' focus alone does not.
//   MISE_ENV=android mise exec -- node scripts/android.ts, then
//   MISE_ENV=android mise exec -- node --test scenarios/platform/android.e2e.ts      RECORD=1 keeps each trace
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { _android, type AndroidDevice, type BrowserContext, type Page } from "playwright-core";
import { buildSite, EMULATOR_TCP, EmulatorConsole, launchAndroidChrome, serveStatic, Touchscreen, WEB } from "../browser.ts";
import { broadcastArgs, runRow } from "./harness.ts";
import { sleep } from "./oskeys.ts";
import { rows, type AndroidNative } from "./rows.ts";

const root = new URL("../..", import.meta.url).pathname;
const IME = "de.k5d.breezy.ime/.Ime";
const adb = (...args: string[]) => execFileSync("adb", ["-s", EMULATOR_TCP, ...args], { encoding: "utf8" });
const skip = (() => {
  try {
    return !execFileSync("adb", ["devices"], { encoding: "utf8" }).includes(`${EMULATOR_TCP}\tdevice`) && "no emulator: run node scripts/android.ts";
  } catch {
    return "no adb: run under MISE_ENV=android mise exec --";
  }
})();

let device: AndroidDevice, context: BrowserContext, page: Page, touchscreen: Touchscreen, emulatorConsole: EmulatorConsole;
let site: ReturnType<typeof serveStatic>, keyboard = "";

/** The emulator's own keyboard back, also on ⌃C. */
function restoreKeyboard() {
  try {
    if (keyboard) adb("shell", "ime", "set", keyboard);
  } catch {}
}

before(async () => {
  if (skip) return;
  execFileSync(join(root, "tools/breezy-ime/build.sh"), [join(root, "build/breezy-ime")], { stdio: ["ignore", "ignore", "inherit"] });
  adb("install", "-r", join(root, "build/breezy-ime/ime.apk"));
  keyboard = adb("shell", "settings", "get", "secure", "default_input_method").trim();
  process.once("exit", restoreKeyboard);
  process.once("SIGINT", () => {
    restoreKeyboard();
    process.exit(130);
  });
  adb("shell", "ime", "enable", IME);
  adb("shell", "ime", "set", IME);
  const dir = join(root, "build", "web-platform");
  buildSite(dir);
  site = serveStatic(dir, WEB);
  adb("reverse", `tcp:${WEB}`, `tcp:${WEB}`);
  const devices = await _android.devices();
  device = devices.find((d) => d.serial() === EMULATOR_TCP)!;
  for (const d of devices) if (d !== device) await d.close();
  context = await launchAndroidChrome(device);
  page = await context.newPage();
  for (const p of context.pages()) if (p !== page) await p.close();
  const emulator = /^(emulator-\d+)\tdevice$/m.exec(execFileSync("adb", ["devices"], { encoding: "utf8" }))![1]!;
  emulatorConsole = await EmulatorConsole.open(emulator);
  // calibrates on a page of its own, so before the app's
  touchscreen = await Touchscreen.of(EMULATOR_TCP, emulatorConsole, page);
});

after(async () => {
  restoreKeyboard();
  await context?.close();
  await device?.close();
  emulatorConsole?.close();
  site?.close();
});

for (const row of rows) {
  const drive = row.native.android;
  if (!drive) continue;
  test(`${row.id}-${row.variant} on android: ${row.title}`, { skip, todo: row.open.includes("android") }, async () => {
    await page.goto(`http://localhost:${WEB}/?demo=edit&record`);
    await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
    // a real touch at the end of the card's text starts the keyboard there
    const end = await page.evaluate(() => {
      const r = document.activeElement!.getBoundingClientRect();
      return { x: r.right - 4, y: r.bottom - 6 };
    });
    await touchscreen.send([[0, "down", end]]);
    await sleep(60);
    await touchscreen.send([[0, "up", end]]);
    await sleep(1500);
    await page.evaluate(() => getSelection()!.collapse(document.activeElement!, document.activeElement!.childNodes.length));
    await sleep(300);
    const n: AndroidNative = {
      ime: (op, extras = {}) => void adb(...broadcastArgs(op, extras)),
      adb,
      text: () => page.evaluate(async () => ((await import("/record.js" as string)) as typeof import("../../web/record.ts")).editorState().text),
      wait: sleep,
    };
    const trace = await runRow(page, row, "android", IME, () => drive(n));
    assert.equal(row.expect(trace.before, trace.after), null);
  });
}
```

Each `ime` call goes through `adb shell`, which takes a few hundred ms. Rows wait 300 ms after each call so that Chrome has handled it before the next one.

- [ ] **Step 3: Run it with no Android rows yet**

Run: `MISE_ENV=android mise exec -- node --test scenarios/platform/android.e2e.ts`
Expected: 0 tests, and `before` succeeds: the input method installs and the keyboard comes back afterwards. Check with `adb -s 127.0.0.1:5600 shell settings get secure default_input_method`, which should print `com.google.android.inputmethod.latin/com.android.inputmethod.latin.LatinIME`.

- [ ] **Step 4: Run it on every push**

In `.github/workflows/main.yaml`'s `android` job, after `- name: Scenarios on Android`, add:
```yaml
    - name: Platform rows on Android
      timeout-minutes: 8
      run: mise exec -- node --test --test-force-exit scenarios/platform/android.e2e.ts
```
Run: `actionlint .github/workflows/main.yaml`; expected: no output.

- [ ] **Step 5: Commit**

```bash
git add scenarios/browser.ts scenarios/platform/android.e2e.ts .github/workflows/main.yaml
git commit --message "Run the platform rows in Chrome on the Android emulator through a keyboard of our own, opening each editor with a real touch" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 4: The Android rows

**Files:**
- Modify: `scenarios/platform/rows.ts`
- Modify: `scenarios/platform/rows.test.ts`
- Modify: `docs/platform-expectations.md`
- Create: `scenarios/traces/android/*.json` (recorded)

**Interfaces:**
- Consumes: `AndroidNative`, `inserted`, `ended` (`rows.ts`).
- Produces: rows `A1-commit`, `A2-compose`, `A3-korean`, `A7-autocorrect`, `A10-swipe`, `A12-suggestion`, `C1-delete`, `D7-select`, `F1-app`, `F2-rotate`, each with `native.android`.

- [ ] **Step 1: Write the failing tests for the new expectations**

Append to `scenarios/platform/rows.test.ts`:
```ts
test("a suggestion picked replaces the word before the caret", () => {
  const s = rowOf("A12", "suggestion");
  assert.equal(s.expect(state("Plan budget"), state("Plan budgets")), null);
  assert.match(s.expect(state("Plan budget"), state("Plan budgetbudgets"))!, /budgetbudgets/);
});

test("a selection set by the keyboard puts what it types there", () => {
  const d7 = rowOf("D7", "select");
  assert.equal(d7.expect(state("Plan budget"), state("Plan budXget", 9)), null);
  assert.match(d7.expect(state("Plan budget"), state("Plan budgetX"))!, /budgetX/);
});

test("deleting an emoji with a skin tone deletes all of it", () => {
  const c1 = rowOf("C1", "delete");
  assert.equal(c1.expect(state("Plan"), state("Plan")), null);
  assert.match(c1.expect(state("Plan"), state("Plan\u{1F44D}"))!, /👍/u);
});

test("every Android row has native steps", () => {
  for (const [id, variant] of [["A1", "commit"], ["A2", "compose"], ["A3", "korean"], ["A7", "autocorrect"], ["A10", "swipe"], ["A12", "suggestion"], ["C1", "delete"], ["D7", "select"], ["F1", "app"], ["F2", "rotate"]])
    assert.ok(rowOf(id, variant).native.android, `${id}-${variant}`);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test scenarios/platform/rows.test.ts`
Expected: FAIL with `no row A12-suggestion` and the like.

- [ ] **Step 3: Write the rows**

In `scenarios/platform/rows.ts`, add before `export const rows`:
```ts
/** Composes each of `steps` in turn, as a keyboard does key by key. */
const composing = async (n: AndroidNative, ...steps: string[]) => {
  for (const text of steps) {
    n.ime("compose", { text });
    await n.wait(300);
  }
};

const call = async (n: AndroidNative, op: string, extras: Record<string, string | number> = {}) => {
  n.ime(op, extras);
  await n.wait(300);
};

/** Why `after` is not `before` with its last word replaced by `word`, the caret after it, still editing; or null. */
function replacedLastWord(before: EditorState, after: EditorState, word: string): string | null {
  const want = before.text.replace(/\S+$/, word);
  if (after.editing && after.text === want && after.at === want.length) return null;
  return `wanted ${JSON.stringify(want)} with the caret at its end, still edited; got ${show(after)}`;
}
```
and these entries in `rows`:
```ts
  {
    id: "A1", variant: "commit", title: "A keyboard's emoji goes in at the caret",
    native: { android: (n) => call(n, "commit", { text: "😀" }) },
    open: [],
    expect: (b, a) => inserted(b, a, "😀"),
  },
  {
    id: "A2", variant: "compose", title: "Text a keyboard composes goes in once committed, and the edit goes on",
    native: {
      android: async (n) => {
        await composing(n, "に", "にほ", "にほん", "日本");
        await call(n, "commit", { text: "日本" });
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, "日本"),
  },
  {
    // a Korean keyboard composes each syllable from its letters and finishes it as the next one starts
    id: "A3", variant: "korean", title: "Korean syllables go in as composed",
    native: {
      android: async (n) => {
        await composing(n, "ㅎ", "하", "한");
        await call(n, "finish");
        await composing(n, "ㄱ", "그", "글");
        await call(n, "finish");
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, "한글"),
  },
  {
    // as Gboard corrects a word: the composed word committed as corrected, then the space
    id: "A7", variant: "autocorrect", title: "An autocorrected word replaces what was typed",
    native: {
      android: async (n) => {
        await call(n, "commit", { text: " " });
        await composing(n, "t", "te", "teh");
        await call(n, "commit", { text: "the" });
        await call(n, "commit", { text: " " });
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, " the "),
  },
  {
    // a swiped word is composed whole, and the keyboard puts a space before the next
    id: "A10", variant: "swipe", title: "Swiped words go in with the keyboard's spaces",
    native: {
      android: async (n) => {
        await call(n, "commit", { text: " " });
        await composing(n, "hello");
        await call(n, "finish");
        await call(n, "commit", { text: " " });
        await composing(n, "world");
        await call(n, "finish");
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, " hello world"),
  },
  {
    // the keyboard marks the word it suggests for, then commits the suggestion over it
    id: "A12", variant: "suggestion", title: "A suggestion picked replaces the word",
    native: {
      android: async (n) => {
        const text = await n.text();
        const start = text.search(/\S+$/);
        await call(n, "region", { start, end: text.length });
        await call(n, "commit", { text: "budgets" });
      },
    },
    open: [],
    expect: (b, a) => replacedLastWord(b, a, "budgets"),
  },
  {
    // a thumbs-up with a skin tone is four UTF-16 units and one character
    id: "C1", variant: "delete", title: "Backspace deletes a whole emoji",
    native: {
      android: async (n) => {
        await call(n, "commit", { text: "👍🏽" });
        await call(n, "key", { code: 67 });
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, ""),
  },
  {
    // as dragging on Gboard's space bar moves the caret
    id: "D7", variant: "select", title: "The keyboard moves the caret, and typing goes there",
    native: {
      android: async (n) => {
        const at = (await n.text()).length - 3;
        await call(n, "select", { start: at, end: at });
        await call(n, "commit", { text: "X" });
      },
    },
    open: [],
    expect: (b, a) => inserted({ ...b, at: b.at - 3 }, a, "X"),
  },
  {
    // away and back through recents: the page is hidden meanwhile
    id: "F1", variant: "app", title: "Another app ends the edit on a phone, keeping its text",
    native: {
      android: async (n) => {
        n.adb("shell", "input", "keyevent", "KEYCODE_APP_SWITCH");
        await n.wait(1500);
        n.adb("shell", "input", "keyevent", "KEYCODE_APP_SWITCH");
        await n.wait(1500);
      },
    },
    open: [],
    expect: ended,
  },
  {
    id: "F2", variant: "rotate", title: "Turning the phone keeps the edit, and typing goes on",
    native: {
      android: async (n) => {
        n.adb("shell", "settings", "put", "system", "accelerometer_rotation", "0");
        n.adb("shell", "settings", "put", "system", "user_rotation", "1");
        try {
          await n.wait(2000);
          await call(n, "commit", { text: "x" });
        } finally {
          n.adb("shell", "settings", "put", "system", "user_rotation", "0");
          await n.wait(2000);
        }
      },
    },
    open: [],
    expect: (b, a) => inserted(b, a, "x"),
  },
```
A12 and D7 read the editor's text with `n.text()` to pick their offsets.

Before committing, check the offset counting against Review Focus 4. Chrome's `setComposingRegion` and `setSelection` count UTF-16 units of the editable text with a newline for each line break, as `editorState().text` does for the demo card. If A12 or D7 mark the wrong range, read `region` and `select` off the trace's `selection` steps and correct the offset, rather than adjusting the expectation.

- [ ] **Step 4: Run the row tests**

Run: `node --test scenarios/platform/rows.test.ts && npm run check`
Expected: all pass; no errors.

- [ ] **Step 5: Run the rows natively and record**

Run: `MISE_ENV=android mise exec -- env RECORD=1 node --test scenarios/platform/android.e2e.ts`
Expected: 10 results. For each that fails, read its message and its trace in `build/platform/<row>-<variant>-android.json`:
- If the input method's sequence is not what the row means (for example Chrome needs `finish` before a commit), correct the row's steps and run again.
- If the app is at fault, add `"android"` to the row's `open` and note the cause in the catalogue.
Then run `node --test scenarios/platform/replay.test.ts`. Expected: each Android trace passes in Chromium, Firefox and WebKit where its row passed natively, and is todo where the row is open. A replay that disagrees with the native run means `replaySteps` lacks something the trace shows. Fix it there, as part 1 did.

- [ ] **Step 6: Update the catalogue and commit**

In `docs/platform-expectations.md`, set each of A1, A2, A3, A7, A10, A12, C1, D7, F1 and F2's status to include `green on android` or `red on android: <cause>`.
```bash
git add scenarios/platform/rows.ts scenarios/platform/rows.test.ts scenarios/platform/android.e2e.ts scenarios/traces/android docs/platform-expectations.md
git commit --message "Test what Android keyboards do to a card in Chrome: emoji, composing Japanese and Korean, autocorrect, swiped words, suggestions, deleting an emoji, moving the caret, another app and turning the phone" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 5: Fix what is red

**Files:** decided by each cause; the red row's replay is its test.

For each row Task 4 left open on `android`, one at a time:

- [ ] **Step 1:** Use superpowers:systematic-debugging on the row's trace and the code it reaches (`web/field.ts`, `web/keys.ts`, `web/input.ts`), until the cause is known and written down.
- [ ] **Step 2:** Confirm the red test. Run `node --test --test-name-pattern "<row>-<variant>" scenarios/platform/replay.test.ts`; expected: todo, failing with the row's message. Where the bug changes what Chrome sends next, so that the trace cannot show the fix, add a unit test in `web/test/` that fails for the cause instead.
- [ ] **Step 3:** Fix the cause, the smallest change that does it.
- [ ] **Step 4:** Remove `"android"` from the row's `open`. Run the row natively with `RECORD=1` so its trace shows the fixed behaviour, then run `npm test`, `node --test scenarios/*.test.ts scenarios/platform/*.test.ts` and `MISE_ENV=android mise exec -- node --test scenarios/platform/android.e2e.ts`. Expected: all pass.
- [ ] **Step 5:** Commit the fix with the trace and the catalogue's status, the message saying what a person saw go wrong and what now happens.

---

### Task 6: Close part 4

- [ ] **Step 1:** Run `npm run check && npm test && node --test scenarios/*.test.ts scenarios/platform/*.test.ts`, then `MISE_ENV=android mise exec -- node --test scenarios/platform/android.e2e.ts`, then `node --test --test-concurrency=1 scenarios/platform/oskeys.e2e.ts scenarios/platform/native.e2e.ts`. Expected: all pass, no todo left except rows noted as open.
- [ ] **Step 2:** Tell your human partner which Android rows are green and which are open and why, and that B3, D11, D12, the E and G rows and Gboard's emoji tab are left for the next Android part.
