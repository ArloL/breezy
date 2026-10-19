# Platform input, part 1: spikes, traces, Firefox on the Mac — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Answer the spec's three spikes, build the trace and row machinery, and test rows A1 (emoji picker), A2 (input method Enter and Esc) and F1 (focus leaving briefly) natively in stock Firefox on the Mac and by replay on every push, fixing A2 and F1.

**Architecture:** `tools/oskeys` posts real macOS input. Playwright drives stock Firefox (`channel: "moz-firefox"`) for setup and readback only. `web/record.ts` records what the input did as a trace, and `scenarios/platform/rows.ts` states what should have come of it. `replay.test.ts` feeds each committed trace to Chromium, Firefox and WebKit and checks the same row.

**Tech Stack:** Swift 6 (AppKit, Carbon TIS, Accessibility), TypeScript on Node 24 with `node:test`, playwright-core 1.64.0, Android SDK command-line tools for spike 3.

**Spec:** `docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md`

Later plans, written once the spikes have answered: part 2, the remaining `firefox-mac` rows; part 3, the Mac app; part 4, Android; part 5, the manual layer; part 6, G rows.

## Global Constraints

- Targets in this part: `firefox-mac` only; spikes also touch `mac`'s runner question and `android`.
- Native runs take over this Mac's keyboard and focus; nothing may type into an app other than the one under test.
- Input sources are restored to the one current before a run, also when it fails or is interrupted.
- A row's replay checks the row's `expect`, never the trace's recorded `after`.
- A failing row is a `todo` test until its fix lands; CI stays green.
- Node ≥ 24, `playwright-core` 1.64.0, Swift tools 6.0, macOS 15 or later, stock Firefox at `/Applications/Firefox.app`.
- Code reads like the surrounding code: few comments, each saying why; doc comments as in `web/field.ts`.
- Commit messages are sentences saying what changed for a person, as in `git log`, ending with the `Claude-Session:` line.

## Review Focus

1. A run interrupted with ⌃C leaves the Mac on Japanese input: the harness restores the input source on `SIGINT` too (Task 1, Task 7).
2. The person clicks another app mid-run and keys land in their documents: every `oskeys` input checks the frontmost process first and refuses otherwise (Task 1, Task 7).
3. The person's own Firefox is running: activation targets the test's Firefox by process, found by its profile path (Task 7).
4. Enter or Esc while composing in a lane's title or the Find field ends the rename or steps the search: one predicate, `composingKey`, guards all three places and is unit-tested (Task 9).
5. Safari sends Enter's keydown after `compositionend` with `isComposing` false and `keyCode` 229: `composingKey` treats 229 as composing (Task 9).

---

### Task 1: `tools/oskeys` and its echo app

**Files:**
- Create: `tools/oskeys/Package.swift`
- Create: `tools/oskeys/Sources/oskeys/main.swift`
- Create: `tools/oskeys/Sources/oskeys-echo/main.swift`
- Create: `scenarios/platform/oskeys.ts`
- Create: `scenarios/platform/oskeys.e2e.ts`
- Modify: `scenarios/tsconfig.json` (include `platform/*.ts`)
- Modify: `.gitignore` (add `tools/oskeys/.build/`)

**Interfaces:**
- Produces: CLI `oskeys trusted | frontmost | activate PID | key NAME [MODS] | type ASCII | text STRING | source [ID] | emoji NAME | away PID`. `source` without an ID prints the current one; with an ID it prints the one it replaced.
- Produces (`scenarios/platform/oskeys.ts`): `buildOskeys(): void`, `oskeys(...args: string[]): string`, `trusted(): boolean`, `class Echo { static start(): Promise<Echo>; pid: number; lines: EchoLine[]; until(what: string, test: (l: EchoLine) => boolean, ms?: number): Promise<EchoLine>; stop(): void }`, `type EchoLine = { call?: string; text?: string; selector?: string; string: string; marked: boolean; ready?: number }`, `sleep(ms): Promise<void>`, `restoreSourceOnExit(id: string): void`.

- [ ] **Step 1: Write the package manifest**

`tools/oskeys/Package.swift`:
```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "oskeys",
  platforms: [.macOS(.v15)],
  targets: [
    .executableTarget(name: "oskeys"),
    .executableTarget(name: "oskeys-echo"),
  ]
)
```

Add `tools/oskeys/.build/` to `.gitignore`.

- [ ] **Step 2: Write the echo app**

`tools/oskeys/Sources/oskeys-echo/main.swift`:
```swift
// A window with a text view that writes each text input call it gets, and its text after, as a JSON line on stdout:
// what oskeys's input reached, for scenarios/platform/oskeys.e2e.ts. Ends with its stdin.
import AppKit

func plain(_ s: Any) -> String { (s as? NSAttributedString)?.string ?? s as? String ?? "" }

final class EchoTextView: NSTextView {
  func emit(_ o: [String: Any]) {
    var o = o
    o["string"] = string
    o["marked"] = hasMarkedText()
    FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: o) + Data("\n".utf8))
  }

  override func insertText(_ s: Any, replacementRange r: NSRange) {
    super.insertText(s, replacementRange: r)
    emit(["call": "insertText", "text": plain(s)])
  }

  override func setMarkedText(_ s: Any, selectedRange sel: NSRange, replacementRange r: NSRange) {
    super.setMarkedText(s, selectedRange: sel, replacementRange: r)
    emit(["call": "setMarkedText", "text": plain(s)])
  }

  override func unmarkText() {
    super.unmarkText()
    emit(["call": "unmarkText"])
  }

  override func doCommand(by selector: Selector) {
    super.doCommand(by: selector)
    emit(["call": "doCommand", "selector": NSStringFromSelector(selector)])
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let window = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 480, height: 240), styleMask: [.titled], backing: .buffered, defer: false)
let view = EchoTextView(frame: window.contentView!.bounds)
window.contentView = view
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(view)
FileHandle.standardInput.readabilityHandler = { h in
  if h.availableData.isEmpty { exit(0) }
}
DispatchQueue.main.async { view.emit(["ready": Int(ProcessInfo.processInfo.processIdentifier)]) }
app.run()
```

- [ ] **Step 3: Write the CLI**

`tools/oskeys/Sources/oskeys/main.swift`:
```swift
// Real input for the platform scenarios: keys posted as a keyboard posts them, input sources, the emoji picker.
// Needs Accessibility permission for the terminal that runs it. Input commands refuse to run unless OSKEYS_PID, when
// set, is the frontmost process, so that keys never land in another app.
import AppKit
import Carbon

func fail(_ message: String) -> Never {
  FileHandle.standardError.write(Data("oskeys: \(message)\n".utf8))
  exit(1)
}

let codes: [String: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14,
  "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27,
  "8": 28, "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41,
  "\\": 42, ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
  "return": 36, "tab": 48, "space": 49, "delete": 51, "escape": 53, "forwarddelete": 117,
  "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119,
]
let modifiers: [String: (CGEventFlags, CGKeyCode)] = [
  "cmd": (.maskCommand, 55), "shift": (.maskShift, 56), "opt": (.maskAlternate, 58), "ctrl": (.maskControl, 59),
]

let source = CGEventSource(stateID: .hidSystemState)

func post(_ code: CGKeyCode, _ flags: CGEventFlags, down: Bool) {
  let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)!
  e.flags = flags
  e.post(tap: .cghidEventTap)
}

/// Presses `code` with `mods` held, each modifier going down and up as on a keyboard.
func press(_ code: CGKeyCode, _ mods: [String] = []) {
  var flags: CGEventFlags = []
  for m in mods {
    guard let (flag, key) = modifiers[m] else { fail("no modifier \(m)") }
    flags.insert(flag)
    post(key, flags, down: true)
  }
  post(code, flags, down: true)
  usleep(8_000)
  post(code, flags, down: false)
  for m in mods.reversed() {
    let (flag, key) = modifiers[m]!
    flags.remove(flag)
    post(key, flags, down: false)
  }
  usleep(30_000)
}

func typeKeys(_ s: String) {
  for c in s {
    let lower = String(c).lowercased()
    guard let code = codes[lower] else { fail("no US key for \(c)") }
    press(code, c.isUppercase ? ["shift"] : [])
  }
}

func text(_ s: String) {
  for c in s {
    let u = Array(String(c).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)!
      e.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
      e.post(tap: .cghidEventTap)
    }
    usleep(30_000)
  }
}

func frontmost() -> pid_t { NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1 }

func activate(_ pid: pid_t) {
  let app = AXUIElementCreateApplication(pid)
  guard AXUIElementSetAttributeValue(app, kAXFrontmostAttribute as CFString, kCFBooleanTrue) == .success else { fail("cannot bring \(pid) to the front") }
  for _ in 0..<50 where frontmost() != pid { usleep(100_000) }
  if frontmost() != pid { fail("\(pid) did not come to the front") }
}

func inputSourceID(_ s: TISInputSource) -> String {
  Unmanaged<CFString>.fromOpaque(TISGetInputSourceProperty(s, kTISPropertyInputSourceID)).takeUnretainedValue() as String
}

func currentSource() -> String { inputSourceID(TISCopyCurrentKeyboardInputSource().takeRetainedValue()) }

func selectSource(_ id: String) {
  let filter = [kTISPropertyInputSourceID as String: id] as CFDictionary
  guard let list = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource], let s = list.first else { fail("no input source \(id)") }
  TISEnableInputSource(s)
  guard TISSelectInputSource(s) == noErr else { fail("cannot select \(id)") }
  for _ in 0..<50 where currentSource() != id { usleep(100_000) }
  if currentSource() != id { fail("\(id) did not become current") }
}

/// Input commands only reach the process the run is about.
func guardFront() {
  guard let want = ProcessInfo.processInfo.environment["OSKEYS_PID"].flatMap(pid_t.init) else { return }
  if frontmost() != want { fail("\(frontmost()) is frontmost, not \(want): refusing to type") }
}

let args = Array(CommandLine.arguments.dropFirst())
switch (args.first, args.count) {
case ("trusted", 1):
  exit(AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) ? 0 : 1)
case ("frontmost", 1):
  print(frontmost())
case ("activate", 2):
  activate(pid_t(args[1]) ?? fail("not a pid: \(args[1])"))
case ("key", 2), ("key", 3):
  guardFront()
  press(codes[args[1]] ?? fail("no key \(args[1])"), args.count == 3 ? args[2].split(separator: "+").map(String.init) : [])
case ("type", 2):
  guardFront()
  typeKeys(args[1])
case ("text", 2):
  guardFront()
  text(args[1])
case ("source", 1):
  print(currentSource())
case ("source", 2):
  print(currentSource())
  selectSource(args[1])
case ("emoji", 2):
  guardFront()
  press(codes["space"]!, ["ctrl", "cmd"])
  usleep(900_000)
  // the picker has the keyboard now, not the process OSKEYS_PID names
  text(args[1])
  usleep(600_000)
  press(codes["return"]!)
case ("away", 2):
  let pid = pid_t(args[1]) ?? fail("not a pid: \(args[1])")
  guard let finder = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.finder").first else { fail("no Finder") }
  activate(finder.processIdentifier)
  usleep(700_000)
  activate(pid)
default:
  fail("""
    usage: oskeys trusted | frontmost | activate PID | key NAME [cmd+ctrl+opt+shift] | type ASCII | text STRING
           | source [ID] | emoji NAME | away PID
    """)
}
```

- [ ] **Step 4: Build it**

Run: `swift build --package-path tools/oskeys --configuration release`
Expected: `Build complete!`. Fix compile errors before going on.

- [ ] **Step 5: Write the Node helpers**

`scenarios/platform/oskeys.ts`:
```ts
// tools/oskeys from the scenarios: real macOS input, and its echo app, a text view that reports what reached it.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const bin = (name: string) => join(root, "tools/oskeys/.build/release", name);
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildOskeys() {
  execFileSync("swift", ["build", "--package-path", join(root, "tools/oskeys"), "--configuration", "release"], { stdio: ["ignore", "ignore", "inherit"] });
}

/** Runs oskeys; input commands refuse unless process `front`, when given, is frontmost. */
export function oskeys(args: string[], front?: number): string {
  return execFileSync(bin("oskeys"), args, { encoding: "utf8", env: { ...process.env, ...front ? { OSKEYS_PID: String(front) } : {} } }).trim();
}

export function trusted() {
  try {
    oskeys(["trusted"]);
    return true;
  } catch {
    return false;
  }
}

/** Puts input source `id` back when the run ends, also on ⌃C. */
export function restoreSourceOnExit(id: string) {
  const restore = () => {
    try {
      oskeys(["source", id]);
    } catch {}
  };
  process.once("exit", restore);
  process.once("SIGINT", () => {
    restore();
    process.exit(130);
  });
}

export type EchoLine = { call?: string; text?: string; selector?: string; string: string; marked: boolean; ready?: number };

export class Echo {
  readonly lines: EchoLine[] = [];
  pid = 0;
  private constructor(private readonly child: ChildProcess) {}

  static async start(): Promise<Echo> {
    const e = new Echo(spawn(bin("oskeys-echo"), [], { stdio: ["pipe", "pipe", "inherit"] }));
    let buffer = "";
    e.child.stdout!.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let nl; (nl = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(nl + 1)) e.lines.push(JSON.parse(buffer.slice(0, nl)));
    });
    e.pid = (await e.until("the echo app", (l) => l.ready !== undefined)).ready!;
    oskeys(["activate", String(e.pid)]);
    return e;
  }

  async until(what: string, test: (l: EchoLine) => boolean, ms = 5000): Promise<EchoLine> {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
      const l = this.lines.find(test);
      if (l) return l;
    }
    throw new Error(`no ${what} in ${ms} ms; the echo app saw ${JSON.stringify(this.lines)}`);
  }

  /** Its text now. */
  get string() {
    return this.lines.at(-1)?.string ?? "";
  }

  stop() {
    this.child.stdin!.end();
  }
}
```

In `scenarios/tsconfig.json` change `"include": ["*.ts"]` to `"include": ["*.ts", "platform/*.ts"]`.

- [ ] **Step 6: Write the end-to-end test**

`scenarios/platform/oskeys.e2e.ts`:
```ts
// tools/oskeys against its echo app. Takes over this Mac's keyboard for a minute; needs Accessibility for the terminal.
//   node --test scenarios/platform/oskeys.e2e.ts
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { buildOskeys, Echo, oskeys, restoreSourceOnExit, trusted } from "./oskeys.ts";

const skip = process.platform !== "darwin" ? "macOS only" : !trusted() && "the terminal lacks Accessibility permission";
let echo: Echo;

before(async () => {
  if (skip) return;
  buildOskeys();
  restoreSourceOnExit(oskeys(["source"]));
  oskeys(["source", "com.apple.keylayout.ABC"]);
});
after(() => echo?.stop());

test("keys reach the frontmost text view", { skip }, async () => {
  echo = await Echo.start();
  oskeys(["type", "Plan"], echo.pid);
  await echo.until("Plan", (l) => l.string === "Plan");
  oskeys(["key", "left", "opt"], echo.pid);
  await echo.until("⌥← as a command", (l) => l.selector === "moveWordLeft:");
  echo.stop();
});

test("refuses to type while another process is frontmost", { skip }, async () => {
  echo = await Echo.start();
  assert.throws(() => oskeys(["type", "x"], 1));
  echo.stop();
});

test("Kotoeri composes, Return commits", { skip }, async () => {
  echo = await Echo.start();
  oskeys(["source", "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese"]);
  oskeys(["type", "nihon"], echo.pid);
  await echo.until("marked にほん", (l) => l.call === "setMarkedText" && l.text === "にほん");
  oskeys(["key", "return"], echo.pid);
  await echo.until("にほん committed", (l) => !l.marked && l.string === "にほん");
  oskeys(["source", "com.apple.keylayout.ABC"]);
  echo.stop();
});

test("the emoji picker inserts the first match", { skip }, async () => {
  echo = await Echo.start();
  oskeys(["emoji", "grinning"], echo.pid);
  await echo.until("😀", (l) => l.string === "😀");
  echo.stop();
});

test("away and back keeps the text view the keyboard's", { skip }, async () => {
  echo = await Echo.start();
  oskeys(["away", String(echo.pid)]);
  oskeys(["type", "x"], echo.pid);
  await echo.until("x", (l) => l.string === "x");
  echo.stop();
});
```

- [ ] **Step 7: Run it**

Run: `node --test scenarios/platform/oskeys.e2e.ts`
Expected: 5 pass. If every test is skipped for Accessibility, grant the terminal Accessibility in System Settings → Privacy & Security, then run again. If the Kotoeri test fails on "no input source", add Japanese in System Settings → Keyboard → Input Sources once. If the emoji test types "grinning" into the echo app, raise the 900 ms wait in `emoji` and note it. Do not continue until all 5 pass.

- [ ] **Step 8: Type-check and commit**

Run: `npm run check` — expected: no errors.
```bash
git add tools/oskeys scenarios/platform/oskeys.ts scenarios/platform/oskeys.e2e.ts scenarios/tsconfig.json .gitignore
git commit --message "Post real keys, input sources and emoji picks on the Mac from tools/oskeys, tested against a text view that reports what reached it" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 2: Spike 1 — the emoji bug in stock Firefox (throwaway)

**Files:**
- Create (scratchpad, not committed): `$SCRATCH/spike1.ts`, where `$SCRATCH` is the session scratchpad directory
- Modify: `docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md` (add `## Spike results`)

**Interfaces:**
- Consumes: `oskeys`, `trusted`, `restoreSourceOnExit`, `sleep` from Task 1.

- [ ] **Step 1: Serve the web app**

Run in the background: `npm run dev` (serves `web/` on 58565).

- [ ] **Step 2: Write the spike script**

`$SCRATCH/spike1.ts`:
```ts
import { firefox } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { oskeys, sleep } from "/Users/aokeeffe/Developer/breezy/scenarios/platform/oskeys.ts";

const build = process.argv[2] ?? "stock"; // "stock" or "playwright"
const profile = mkdtempSync(join(tmpdir(), "breezy-spike1-"));
const context = await firefox.launchPersistentContext(profile, { ...build === "stock" ? { channel: "moz-firefox" } : {}, headless: false, viewport: { width: 1200, height: 800 } });
const page = context.pages()[0] ?? await context.newPage();
await page.addInitScript(() => {
  const log: string[] = ((window as any).spike = []);
  for (const type of ["keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "focusin", "focusout"])
    addEventListener(type, (e: any) => log.push(`${type} ${e.key ?? ""} ${e.inputType ?? ""} ${JSON.stringify(e.data ?? null)} composing=${e.isComposing} focus=${document.hasFocus()}`), true);
  addEventListener("blur", () => log.push(`window blur`));
  addEventListener("focus", () => log.push(`window focus`));
});
await page.goto("http://localhost:58565/?demo=edit");
await page.waitForFunction(() => document.activeElement?.getAttribute("contenteditable") === "plaintext-only");
const pid = Number(execFileSync("pgrep", ["-o", "-f", profile], { encoding: "utf8" }).trim());
oskeys(["activate", String(pid)]);
await sleep(500);
oskeys(["emoji", "grinning"], pid);
await sleep(1500);
console.log(await page.evaluate(() => ({ text: document.activeElement?.textContent, editing: (document.activeElement as HTMLElement)?.isContentEditable, log: (window as any).spike })));
await context.close();
```

- [ ] **Step 3: Run it against stock Firefox, then Playwright's**

Run: `node $SCRATCH/spike1.ts stock` then `node $SCRATCH/spike1.ts playwright`
Expected: the stock run shows the bug: no 😀 in the text, or the edit ended. Read the event log for the cause: a `focusout` with `focus=false` before any `input` means the picker's panel blurred the editor and `DomField`'s `onblur` ended the edit; composition events around a 😀 that then vanishes point at `composeInTitle` or `redrawFront`. Repeat with the caret in the title of an empty card (double-click empty board, then run the emoji step) to tell the two apart.

- [ ] **Step 4: Write down the results**

Append to the spec:
```markdown
## Spike results

| Spike | Result | Consequence |
|---|---|---|
| 1 Firefox emoji | <what the log showed, in one sentence; whether Playwright's Firefox shows it too> | <e.g. "F1's fix covers A1" or "A1 needs its own fix in composeInTitle"> |
```
If neither Firefox build reproduces the bug, stop and tell your human partner before Task 3: the native layer would then need another way into Firefox.

- [ ] **Step 5: Commit the results only**

```bash
git add docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md
git commit --message "Note what Firefox on the Mac does with the emoji picker's character" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 3: Spike 2 — native input on GitHub's macOS runners (throwaway)

**Files:**
- Create on a branch that is deleted after: `.github/workflows/oskeys-spike.yaml`
- Modify: the spec's `## Spike results`

- [ ] **Step 1: Write the workflow**

```yaml
name: oskeys spike
on: workflow_dispatch
permissions: {}
jobs:
  spike:
    runs-on: macos-latest
    steps:
    - uses: actions/checkout@v5
      with:
        persist-credentials: false
    - uses: jdx/mise-action@v3
    - run: npm ci
    - run: sudo automationmodetool enable-automationmode-without-authentication
    - run: swift build --package-path tools/oskeys --configuration release
    - run: tools/oskeys/.build/release/oskeys trusted || echo "not trusted"
    - run: node --test scenarios/platform/oskeys.e2e.ts
```

Copy the `uses:` pins from `.github/workflows/desktop-soak.yaml` so they match this repo's pinned actions.

- [ ] **Step 2: Ask before pushing**

Pushing a branch and running a workflow is outward-facing: ask your human partner, then `git switch --create spike/oskeys-runner`, commit the workflow, `git push --set-upstream origin spike/oskeys-runner`, `gh workflow run oskeys-spike.yaml --ref spike/oskeys-runner`, and `gh run watch`.

- [ ] **Step 3: Record and clean up**

Add a row to `## Spike results`: whether `trusted` passed and which of the 5 tests passed on the runner, and the consequence (native layer nightly in CI, or local only). Then `git push origin --delete spike/oskeys-runner`, `git switch main`, `git branch --delete --force spike/oskeys-runner`, and commit the spec change on `main`.

---

### Task 4: Spike 3 — a test input method in Chrome on the emulator (throwaway)

**Files:**
- Create (scratchpad, not committed): `$SCRATCH/ime/AndroidManifest.xml`, `$SCRATCH/ime/res/xml/method.xml`, `$SCRATCH/ime/src/de/k5d/breezy/ime/Ime.java`, `$SCRATCH/ime/build.sh`, `$SCRATCH/spike3.ts`
- Modify: the spec's `## Spike results`

All commands run under `MISE_ENV=android mise exec --`, with the emulator booted by `node scripts/android.ts`.

- [ ] **Step 1: Install the build tools**

Run: `MISE_ENV=android mise exec -- sdkmanager "build-tools;35.0.0" "platforms;android-35"`

- [ ] **Step 2: Write the input method**

`AndroidManifest.xml`:
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
`res/xml/method.xml`:
```xml
<input-method xmlns:android="http://schemas.android.com/apk/res/android"/>
```
`src/de/k5d/breezy/ime/Ime.java`:
```java
package de.k5d.breezy.ime;

import android.content.*;
import android.inputmethodservice.InputMethodService;
import android.view.*;
import android.view.inputmethod.*;

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
        case "delete": ic.deleteSurroundingText(i.getIntExtra("before", 1), 0); break;
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

  /** As tall as a phone's keyboard, so that the page makes room as it does for one. */
  @Override public View onCreateInputView() {
    View v = new View(this);
    v.setMinimumHeight(700);
    v.setBackgroundColor(0xff202124);
    return v;
  }
}
```
`build.sh`:
```bash
#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
bt=$ANDROID_HOME/build-tools/35.0.0
jar=$ANDROID_HOME/platforms/android-35/android.jar
rm -rf out && mkdir -p out/classes
"$bt/aapt2" compile --dir res -o out/res.zip
"$bt/aapt2" link out/res.zip -I "$jar" --manifest AndroidManifest.xml -o out/unsigned.apk --min-sdk-version 33 --target-sdk-version 35
javac --release 17 -classpath "$jar" -d out/classes src/de/k5d/breezy/ime/Ime.java
"$bt/d8" --lib "$jar" --min-api 33 --output out $(find out/classes -name '*.class')
(cd out && zip -q unsigned.apk classes.dex)
"$bt/zipalign" -f 4 out/unsigned.apk out/aligned.apk
[[ -f out/key.jks ]] || keytool -genkeypair -keystore out/key.jks -storepass android -keypass android -alias k -keyalg RSA -dname CN=spike -validity 1000 >/dev/null
"$bt/apksigner" sign --ks out/key.jks --ks-pass pass:android --out out/ime.apk out/aligned.apk
```

- [ ] **Step 3: Build, install, select**

Run:
```bash
MISE_ENV=android mise exec -- bash $SCRATCH/ime/build.sh
MISE_ENV=android mise exec -- adb install -r $SCRATCH/ime/out/ime.apk
MISE_ENV=android mise exec -- adb shell ime enable de.k5d.breezy.ime/.Ime
MISE_ENV=android mise exec -- adb shell ime set de.k5d.breezy.ime/.Ime
```
Expected: `Input method de.k5d.breezy.ime/.Ime selected for user #0`.

- [ ] **Step 4: Compose into a card and log what Chrome sends**

`$SCRATCH/spike3.ts`: connect with `_android.devices()`, `adb reverse tcp:58565 tcp:58565`, `launchBrowser()`, add the same init script as Task 2's `spike1.ts` to log events, open `http://localhost:58565/?demo=edit`, then for each op run `adb shell am broadcast -a de.k5d.breezy.ime.OP --es op compose --es text に`, `… --es text にほ`, `… --es text にほん`, `… --es op commit --es text 日本`, `… --es op commit --es text 😀`, `… --es op key --ei code 66`, sleeping 300 ms between, and print the text, whether the editor is still editing, and the log.

Expected: `compositionupdate` events with `isComposing` true, the text ending in `日本😀`, and Enter either as a `keydown` with key `Enter` or a `beforeinput` `insertParagraph`. Compare with the same sequence through `BrowserDevice.compose` (CDP `Input.imeSetComposition`) by logging that path in the same page.

- [ ] **Step 5: Record and restore**

Add a row to `## Spike results`: whether Chrome took each call, and how its events differ from CDP's composition. Then `adb shell ime reset` and `adb uninstall de.k5d.breezy.ime`. Commit the spec change.

- [ ] **Step 6: Check the design against the results**

If any spike's consequence contradicts the spec, stop and tell your human partner, quoting the spike results, before Task 5.

---

### Task 5: Traces and the recorder

**Files:**
- Create: `web/record.ts`
- Create: `web/test/record.test.ts`
- Modify: `web/main.ts` (load the recorder with `?record`)

**Interfaces:**
- Produces (`web/record.ts`):
  - `type Kind = "front" | "notes" | "title"`
  - `interface EditorState { text: string; at: number; kind: Kind | null; editing: boolean }`
  - `type Step` (as below)
  - `interface Trace { row: string; variant: string; target: string; source: "native" | "phone" | "manual"; ua: string; keyboard: string; before: EditorState; steps: Step[]; after: EditorState }`
  - `toStep(e: EventFields, t: number, range: [number, number] | null, hasFocus: boolean): Step | null`
  - `textOffset(el: HTMLElement, node: Node, offset: number): number`, `domPoint(el: HTMLElement, at: number): [Node, number]`, `editorState(): EditorState`
  - `install(): void`, which sets `window.breezyRecord = { start(meta: Omit<Trace, "ua" | "before" | "steps" | "after">): void; stop(): Trace }`

- [ ] **Step 1: Write the failing test**

`web/test/record.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { toStep } from "../record.ts";

const base = { key: undefined, code: undefined, isComposing: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, data: undefined, inputType: undefined, target: "editor" as const };

test("a key keeps what a replay needs to tell it from typing", () => {
  assert.deepEqual(toStep({ ...base, type: "keydown", key: "Escape", code: "Escape", isComposing: true, keyCode: 229 }, 12.4, null, true),
    { t: 12, type: "keydown", key: "Escape", code: "Escape", isComposing: true, keyCode: 229, mods: "" });
  assert.equal((toStep({ ...base, type: "keydown", key: "z", code: "KeyZ", metaKey: true, shiftKey: true, keyCode: 90 }, 0, null, true) as { mods: string }).mods, "meta+shift");
});

test("an input keeps its type, data and the range it replaced", () => {
  assert.deepEqual(toStep({ ...base, type: "input", inputType: "insertCompositionText", data: "に", isComposing: true }, 3, [4, 4], true),
    { t: 3, type: "input", inputType: "insertCompositionText", data: "に", isComposing: true, range: [4, 4] });
});

test("focus changes keep whether the page had focus", () => {
  assert.deepEqual(toStep({ ...base, type: "focusout" }, 90, null, false), { t: 90, type: "blur", of: "editor", hasFocus: false });
  assert.deepEqual(toStep({ ...base, type: "blur", target: "window" }, 91, null, false), { t: 91, type: "blur", of: "window", hasFocus: false });
});

test("events a replay does not need are left out", () => {
  assert.equal(toStep({ ...base, type: "pointermove" }, 0, null, true), null);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test web/test/record.test.ts`
Expected: FAIL, `Cannot find module '../record.ts'`.

- [ ] **Step 3: Write the recorder**

`web/record.ts`:
```ts
/**
 * Records what a platform's input did to the editor, as a trace that scenarios/platform/replay.test.ts replays: see
 * docs/superpowers/specs/2026-10-19-breezy-platform-input-design.md. Loaded only with ?record.
 */
export type Kind = "front" | "notes" | "title";

export interface EditorState {
  text: string;
  /** The caret's offset in `text`. */
  at: number;
  kind: Kind | null;
  editing: boolean;
}

export type Step =
  | { t: number; type: "keydown" | "keyup"; key: string; code: string; isComposing: boolean; keyCode: number; mods: string }
  | { t: number; type: "compositionstart" | "compositionupdate" | "compositionend"; data: string }
  | { t: number; type: "beforeinput" | "input"; inputType: string; data: string | null; isComposing: boolean; range: [number, number] | null }
  | { t: number; type: "focus" | "blur"; of: "editor" | "window"; hasFocus: boolean }
  | { t: number; type: "selection"; range: [number, number] };

export interface Trace {
  row: string;
  variant: string;
  target: string;
  source: "native" | "phone" | "manual";
  ua: string;
  /** The keyboard or input source, as the person or driver names it. */
  keyboard: string;
  before: EditorState;
  steps: Step[];
  after: EditorState;
}

/** What `toStep` reads of an event, so that it runs without a DOM. */
export interface EventFields {
  type: string;
  target: "editor" | "window";
  key?: string;
  code?: string;
  keyCode?: number;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  data?: string | null;
  inputType?: string;
}

export function toStep(e: EventFields, t: number, range: [number, number] | null, hasFocus: boolean): Step | null {
  t = Math.round(t);
  switch (e.type) {
    case "keydown":
    case "keyup": {
      const mods = (["meta", "ctrl", "alt", "shift"] as const).filter((m) => e[`${m}Key`]).join("+");
      return { t, type: e.type, key: e.key ?? "", code: e.code ?? "", isComposing: !!e.isComposing, keyCode: e.keyCode ?? 0, mods };
    }
    case "compositionstart":
    case "compositionupdate":
    case "compositionend":
      return { t, type: e.type, data: e.data ?? "" };
    case "beforeinput":
    case "input":
      return { t, type: e.type, inputType: e.inputType ?? "", data: e.data ?? null, isComposing: !!e.isComposing, range };
    case "focusin":
    case "focus":
      return { t, type: "focus", of: e.target, hasFocus };
    case "focusout":
    case "blur":
      return { t, type: "blur", of: e.target, hasFocus };
    default:
      return null;
  }
}

const plain = (n: Node): string => n instanceof Text ? n.data : n.nodeName === "BR" ? "\n" : [...n.childNodes].map(plain).join("");

/** The offset in the editor's text, as `DomField` counts it, of DOM point (`node`, `offset`). */
export function textOffset(el: HTMLElement, node: Node, offset: number) {
  const r = document.createRange();
  r.selectNodeContents(el);
  r.setEnd(node, offset);
  return plain(r.cloneContents()).replace(/​/g, "").length;
}

/** The DOM point of offset `at` in the editor's text. */
export function domPoint(el: HTMLElement, at: number): [Node, number] {
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let last: Text | null = null;
  for (let n = walk.nextNode() as Text | null; n; n = walk.nextNode() as Text | null) {
    last = n;
    for (let i = 0; i < n.length; i++) {
      if (n.data[i] === "​") continue;
      if (at-- === 0) return [n, i];
    }
  }
  return last ? [last, last.length] : [el, el.childNodes.length];
}

const editorEl = () => {
  const el = document.activeElement as HTMLElement | null;
  return el?.isContentEditable ? el : document.querySelector<HTMLElement>('[contenteditable="plaintext-only"]');
};

export function editorState(): EditorState {
  const el = editorEl();
  if (!el) return { text: "", at: 0, kind: null, editing: false };
  const kind = (["front", "notes", "title"] as const).find((k) => el.classList.contains(k)) ?? null;
  const sel = getSelection()!;
  const at = sel.rangeCount && el.contains(sel.focusNode) ? textOffset(el, sel.focusNode!, sel.focusOffset) : 0;
  // as DomField.text: an empty last line is drawn from a newline that is not part of the text
  const text = plain(el).replace(/​/g, "").replace(/\n$/, "");
  return { text, at, kind, editing: el.isContentEditable && document.activeElement === el };
}

const TYPES = ["keydown", "keyup", "compositionstart", "compositionupdate", "compositionend", "beforeinput", "input", "focusin", "focusout"];

export function install() {
  let trace: Trace | null = null, t0 = 0, pending: [number, number] | null = null;
  const push = (e: Event, target: "editor" | "window") => {
    if (!trace) return;
    const el = editorEl();
    let range: [number, number] | null = null;
    if (e.type === "beforeinput" && el) {
      const r = (e as InputEvent).getTargetRanges()[0];
      pending = r ? [textOffset(el, r.startContainer, r.startOffset), textOffset(el, r.endContainer, r.endOffset)] : null;
    }
    if (e.type === "beforeinput" || e.type === "input") range = pending;
    if (e.type === "input") pending = null;
    const k = e as KeyboardEvent & InputEvent & CompositionEvent;
    // an event's fields are getters on its prototype, which a spread would not copy
    const fields: EventFields = { type: e.type, target, key: k.key, code: k.code, keyCode: k.keyCode, isComposing: k.isComposing, metaKey: k.metaKey, ctrlKey: k.ctrlKey, altKey: k.altKey, shiftKey: k.shiftKey, data: k.data, inputType: k.inputType };
    const step = toStep(fields, performance.now() - t0, range, document.hasFocus());
    if (step) trace.steps.push(step);
  };
  for (const type of TYPES) addEventListener(type, (e) => push(e, "editor"), true);
  addEventListener("blur", (e) => e.target === window && push(e, "window"));
  addEventListener("focus", (e) => e.target === window && push(e, "window"));
  document.addEventListener("selectionchange", () => {
    const el = editorEl(), sel = getSelection()!;
    if (!trace || !el || !sel.rangeCount || !el.contains(sel.focusNode)) return;
    const range: [number, number] = [textOffset(el, sel.anchorNode!, sel.anchorOffset), textOffset(el, sel.focusNode!, sel.focusOffset)];
    trace.steps.push({ t: Math.round(performance.now() - t0), type: "selection", range });
  });
  (window as unknown as { breezyRecord: unknown }).breezyRecord = {
    start(meta: Omit<Trace, "ua" | "before" | "steps" | "after">) {
      t0 = performance.now();
      trace = { ...meta, ua: navigator.userAgent, before: editorState(), steps: [], after: editorState() };
    },
    stop(): Trace {
      const done = { ...trace!, after: editorState() };
      trace = null;
      return done;
    },
  };
}
```

In `web/main.ts`, after `const params = new URLSearchParams(location.search);`:
```ts
if (params.has("record")) void import("./record.ts").then((m) => m.install());
```

- [ ] **Step 4: Run the tests and the type check**

Run: `node --test web/test/record.test.ts && npm run check`
Expected: 4 pass; no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/record.ts web/test/record.test.ts web/main.ts
git commit --message "Record what a platform's input does to a card's editor, with ?record, as a trace a scenario can replay" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 6: Rows and the catalogue

**Files:**
- Create: `scenarios/platform/rows.ts`
- Create: `scenarios/platform/rows.test.ts`
- Create: `docs/platform-expectations.md`

**Interfaces:**
- Consumes: `EditorState` from `web/record.ts`.
- Produces (`scenarios/platform/rows.ts`):
  - `type Target = "mac" | "firefox-mac" | "android"`
  - `interface Native { pid: number; oskeys(args: string[]): string; wait(ms: number): Promise<void> }`; `oskeys` refuses unless `pid` is frontmost
  - `interface Row { id: string; variant: string; title: string; native: Partial<Record<Target, (n: Native) => Promise<void>>>; open: Target[]; expect(before: EditorState, after: EditorState): string | null }`
  - `const rows: Row[]`, `rowOf(id: string, variant: string): Row`, `inserted(before: EditorState, after: EditorState, s: string): string | null`

- [ ] **Step 1: Write the failing test**

`scenarios/platform/rows.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { inserted, rowOf, rows } from "./rows.ts";

const state = (text: string, at = text.length, editing = true) => ({ text, at, kind: "front" as const, editing });

test("inserted: the string at the caret, the caret after it, still editing", () => {
  assert.equal(inserted(state("Plan"), state("Plan😀"), "😀"), null);
  assert.equal(inserted(state("Plan", 2), state("Pl😀an", 4), "😀"), null);
  assert.match(inserted(state("Plan"), state("Plan"), "😀")!, /Plan/);
  assert.match(inserted(state("Plan"), state("Plan😀", 6, false), "😀")!, /no longer edited/);
  assert.match(inserted(state("Plan"), state("Plangrinning"), "😀")!, /Plangrinning/);
});

test("every row is named once, with a check", () => {
  const names = rows.map((r) => `${r.id}-${r.variant}`);
  assert.deepEqual(names, [...new Set(names)]);
  assert.equal(rowOf("A1", "picker").id, "A1");
  assert.throws(() => rowOf("Z9", "none"));
});

test("Esc while composing cancels the composition and nothing else", () => {
  assert.equal(rowOf("A2", "escape").expect(state("Plan"), state("Plan")), null);
  assert.match(rowOf("A2", "escape").expect(state("Plan"), state("Plan", 4, false))!, /no longer edited/);
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `node --test scenarios/platform/rows.test.ts`
Expected: FAIL, `Cannot find module './rows.ts'`.

- [ ] **Step 3: Write the rows**

`scenarios/platform/rows.ts`:
```ts
// What people assume each platform's input does, one row of docs/platform-expectations.md each: how a target's own
// input does it (layer 1), and what must come of it, which replays of its traces check too (layer 2).
import type { EditorState } from "../../web/record.ts";

export type Target = "mac" | "firefox-mac" | "android";

/** A target's own input, for a row's native steps. */
export interface Native {
  /** The process under test, frontmost. */
  pid: number;
  /** tools/oskeys, refusing unless `pid` is frontmost. */
  oskeys(args: string[]): string;
  wait(ms: number): Promise<void>;
}

export interface Row {
  id: string;
  variant: string;
  title: string;
  native: Partial<Record<Target, (n: Native) => Promise<void>>>;
  /** Targets where the row fails until its fix lands: their tests are todo. */
  open: Target[];
  /** Why `after` breaks the row, or null. */
  expect(before: EditorState, after: EditorState): string | null;
}

const show = (s: EditorState) => `${JSON.stringify(s.text)} with the caret at ${s.at}${s.editing ? "" : ", no longer edited"}`;

/** Why `after` is not `before` with `s` typed at its caret, the caret after it, still editing; or null. */
export function inserted(before: EditorState, after: EditorState, s: string): string | null {
  const want = { text: before.text.slice(0, before.at) + s + before.text.slice(before.at), at: before.at + s.length };
  if (after.editing && after.text === want.text && after.at === want.at) return null;
  return `wanted ${JSON.stringify(want.text)} with the caret at ${want.at}, still edited; got ${show(after)}`;
}

const KOTOERI = "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese";

/** Types romaji `keys` with Japanese input, then presses `end`. The harness puts the input source back. */
const japanese = (keys: string, end: string) => async (n: Native) => {
  n.oskeys(["source", KOTOERI]);
  n.oskeys(["type", keys]);
  await n.wait(300);
  n.oskeys(["key", end]);
  await n.wait(300);
};

export const rows: Row[] = [
  {
    id: "A1", variant: "picker", title: "The emoji picker inserts at the caret",
    native: {
      "firefox-mac": async (n) => {
        n.oskeys(["emoji", "grinning"]);
        await n.wait(800);
      },
    },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, "😀"),
  },
  {
    id: "A2", variant: "enter", title: "Enter confirms an input method's text and the edit goes on",
    native: { "firefox-mac": japanese("nihon", "return") },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, "にほん"),
  },
  {
    id: "A2", variant: "escape", title: "Esc cancels an input method's text and the edit goes on",
    native: { "firefox-mac": japanese("nihon", "escape") },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, ""),
  },
  {
    id: "F1", variant: "away", title: "The edit survives another app taking focus for a moment",
    native: {
      "firefox-mac": async (n) => {
        n.oskeys(["away", String(n.pid)]);
        await n.wait(300);
        n.oskeys(["type", "x"]);
        await n.wait(300);
      },
    },
    open: ["firefox-mac"],
    expect: (b, a) => inserted(b, a, "x"),
  },
];

export function rowOf(id: string, variant: string): Row {
  const r = rows.find((r) => r.id === id && r.variant === variant);
  if (!r) throw new Error(`no row ${id}-${variant}`);
  return r;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --test scenarios/platform/rows.test.ts`
Expected: 3 pass.

- [ ] **Step 5: Write the catalogue**

`docs/platform-expectations.md`: a first paragraph saying what the rows are and pointing at the spec, `scenarios/platform/rows.ts` and `scenarios/traces/`. Then the spec's `## Rows` table copied verbatim, with one more column, `Status`. Status is `red on firefox-mac` for A1, A2 and F1 and `untested` for every other row. Then a short `## Running` section:

```markdown
node --test scenarios/platform/*.test.ts       # rows' checks and every trace's replay, on every push
node --test scenarios/platform/native.e2e.ts   # each row through the platform's own input; takes over this Mac
RECORD=1 node --test scenarios/platform/native.e2e.ts   # the same, keeping each trace in scenarios/traces/
```

- [ ] **Step 6: Commit**

```bash
git add scenarios/platform/rows.ts scenarios/platform/rows.test.ts docs/platform-expectations.md
git commit --message "List what people assume each platform's input does, with checks for the emoji picker, an input method's Enter and Esc, and focus leaving for a moment" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 7: Native rows in stock Firefox

**Files:**
- Modify: `scenarios/browser.ts` (export `serveStatic` and `buildSite`, use them in `RealWorld.serve`)
- Create: `scenarios/platform/native.e2e.ts`

**Interfaces:**
- Consumes: `rows`, `Native`, `Target` (Task 6); `oskeys`, `trusted`, `buildOskeys`, `restoreSourceOnExit`, `sleep` (Task 1); `Trace` (Task 5).
- Produces (`scenarios/browser.ts`): `buildSite(dir: string): void` (runs `scripts/build-site.sh dir VERSION`), `serveStatic(dir: string, port: number): Server`.
- Produces: trace files `build/platform/<row>-<variant>-<target>.json`, and with `RECORD=1` also `scenarios/traces/<target>/<row>-<variant>.json`.

- [ ] **Step 1: Extract the static server**

In `scenarios/browser.ts`, move the body of `RealWorld.serve` that builds the site and creates the HTTP server into:
```ts
/** The web app as it ships, built into `dir`. */
export function buildSite(dir: string) {
  execFileSync(join(root, "scripts/build-site.sh"), [dir, VERSION], { cwd: root, stdio: ["ignore", "ignore", "inherit"] });
}

/** Serves `dir` on 127.0.0.1:`port`. */
export function serveStatic(dir: string, port: number) {
  const types: Record<string, string> = { ".js": "text/javascript", ".html": "text/html", ".css": "text/css", ".png": "image/png", ".webmanifest": "application/manifest+json" };
  return createServer((req, res) => {
    const path = join(dir, new URL(req.url!, "http://x").pathname.replace(/\/$/, "/index.html"));
    if (!existsSync(path)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[extname(path)] ?? "application/octet-stream" }).end(readFileSync(path));
  }).listen(port, "127.0.0.1");
}
```
and in `RealWorld.serve`:
```ts
    const site = join(root, "build", "web-scenarios");
    buildSite(site);
    this.web = serveStatic(site, WEB);
```
Run: `npm run check` — expected: no errors.

- [ ] **Step 2: Write the native test**

`scenarios/platform/native.e2e.ts`:
```ts
// Each row through a target's own input: stock Firefox on this Mac, driven by tools/oskeys; Playwright only opens the
// page and reads it. Takes over the keyboard and focus for minutes; needs Accessibility for the terminal.
//   node --test scenarios/platform/native.e2e.ts         RECORD=1 keeps each trace in scenarios/traces/
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { firefox, type BrowserContext } from "playwright-core";
import { buildSite, serveStatic } from "../browser.ts";
import { buildOskeys, oskeys, restoreSourceOnExit, sleep, trusted } from "./oskeys.ts";
import { rows, type Native } from "./rows.ts";
import type { Trace } from "../../web/record.ts";

const root = new URL("../..", import.meta.url).pathname;
const PORT = 58564;
const FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox";
const skip = process.platform !== "darwin" ? "macOS only"
  : !existsSync(FIREFOX) ? "no Firefox in /Applications"
  : !trusted() && "the terminal lacks Accessibility permission";

let site: ReturnType<typeof serveStatic>, context: BrowserContext, pid: number, profile: string, source: string;

before(async () => {
  if (skip) return;
  buildOskeys();
  source = oskeys(["source"]);
  restoreSourceOnExit(source);
  const dir = join(root, "build", "web-platform");
  buildSite(dir);
  site = serveStatic(dir, PORT);
  profile = mkdtempSync(join(tmpdir(), "breezy-platform-firefox-"));
  context = await firefox.launchPersistentContext(profile, { channel: "moz-firefox", headless: false, viewport: { width: 1200, height: 800 } });
  // the test's Firefox, not the person's: the oldest process started with this profile
  pid = Number(execFileSync("pgrep", ["-o", "-f", profile], { encoding: "utf8" }).trim());
});

after(async () => {
  await context?.close();
  site?.close();
  if (profile) rmSync(profile, { recursive: true, force: true });
  if (source) oskeys(["source", source]);
});

for (const row of rows) {
  const drive = row.native["firefox-mac"];
  if (!drive) continue;
  const name = `${row.id}-${row.variant} on firefox-mac: ${row.title}`;
  test(name, { skip, todo: row.open.includes("firefox-mac") }, async () => {
    const page = context.pages()[0] ?? await context.newPage();
    await page.goto(`http://localhost:${PORT}/?demo=edit&record`);
    await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
    oskeys(["source", "com.apple.keylayout.ABC"]);
    oskeys(["activate", String(pid)]);
    await sleep(300);
    await page.evaluate(([row, variant]) => (window as any).breezyRecord.start({ row, variant, target: "firefox-mac", source: "native", keyboard: "" }), [row.id, row.variant]);
    let keyboard = "com.apple.keylayout.ABC";
    const n: Native = {
      pid,
      oskeys: (args) => {
        if (args[0] === "source" && args[1]) keyboard = args[1];
        return oskeys(args, pid);
      },
      wait: sleep,
    };
    try {
      await drive(n);
    } finally {
      oskeys(["source", "com.apple.keylayout.ABC"]);
    }
    const trace: Trace = await page.evaluate(() => (window as any).breezyRecord.stop());
    trace.keyboard = keyboard;
    const file = `${row.id}-${row.variant}.json`;
    mkdirSync(join(root, "build/platform"), { recursive: true });
    writeFileSync(join(root, "build/platform", `${row.id}-${row.variant}-firefox-mac.json`), JSON.stringify(trace, null, 2));
    if (process.env.RECORD) {
      mkdirSync(join(root, "scenarios/traces/firefox-mac"), { recursive: true });
      writeFileSync(join(root, "scenarios/traces/firefox-mac", file), JSON.stringify(trace, null, 2) + "\n");
    }
    assert.equal(row.expect(trace.before, trace.after), null);
  });
}
```

- [ ] **Step 3: Run it and record the first traces**

Run: `RECORD=1 node --test scenarios/platform/native.e2e.ts`
Expected: four `todo` results, A1, A2-enter, A2-escape and F1, each failing with a message from `inserted`, and four files in `scenarios/traces/firefox-mac/`. Read each failure. A2-escape should say "no longer edited" (the suspect in `web/keys.ts`), and F1 should say the same (the suspect in `web/field.ts`). If a row passes, remove `"firefox-mac"` from its `open`. If a failure has a cause other than the suspects, note it in the trace's commit message.

- [ ] **Step 4: Commit**

```bash
git add scenarios/browser.ts scenarios/platform/native.e2e.ts scenarios/platform/rows.ts scenarios/traces/firefox-mac
git commit --message "Test the emoji picker, an input method's Enter and Esc, and focus leaving for a moment in stock Firefox through the Mac's own input, keeping what Firefox sent as traces" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 8: Replaying traces on every push

**Files:**
- Create: `scenarios/platform/replay.ts`
- Create: `scenarios/platform/replay.test.ts`
- Modify: `.github/workflows/main.yaml` (the job running `node --test scenarios/*.test.ts`)

**Interfaces:**
- Consumes: `Trace`, `Step`, `domPoint`, `editorState` (Task 5, in the page through `?record`); `rowOf` (Task 6); `buildSite`, `serveStatic` (Task 7).
- Produces: `replaySteps(steps: Step[]): Promise<void>` and `setCaret(at: number): Promise<void>`, both run in the page.

Every trace in this part starts from the demo card that `?demo=edit` opens, so a replay only puts the caret where the trace's started; part 5, whose phone traces start from other text, adds setting the text.

- [ ] **Step 1: Write the in-page replayer**

`scenarios/platform/replay.ts`:
```ts
// Replays a trace's steps into the page's editor as the platform delivered them: each event dispatched as recorded,
// and each input's edit made to the DOM just before its input event, as the browser makes it. Runs in the page, which
// loaded web/record.ts with ?record.
import type { Step } from "../../web/record.ts";

type RecordModule = typeof import("../../web/record.ts");

/** Puts the caret at offset `at` of the editor's text. */
export async function setCaret(at: number) {
  const { domPoint }: RecordModule = await import("/record.js" as string);
  getSelection()!.collapse(...domPoint(document.activeElement as HTMLElement, at));
}

export async function replaySteps(steps: Step[]) {
  const { domPoint }: RecordModule = await import("/record.js" as string);
  const editor = () => document.querySelector<HTMLElement>('[contenteditable="plaintext-only"]') ?? document.activeElement as HTMLElement;
  const hasFocus = document.hasFocus.bind(document);
  let last = 0;
  for (const s of steps) {
    await new Promise((r) => setTimeout(r, Math.min(s.t - last, 50)));
    last = s.t;
    const el = editor();
    switch (s.type) {
      case "keydown":
      case "keyup": {
        const mods = s.mods.split("+");
        el.dispatchEvent(new KeyboardEvent(s.type, { key: s.key, code: s.code, isComposing: s.isComposing, keyCode: s.keyCode, metaKey: mods.includes("meta"), ctrlKey: mods.includes("ctrl"), altKey: mods.includes("alt"), shiftKey: mods.includes("shift"), bubbles: true, cancelable: true, composed: true }));
        break;
      }
      case "compositionstart":
      case "compositionupdate":
      case "compositionend":
        el.dispatchEvent(new CompositionEvent(s.type, { data: s.data, bubbles: true, cancelable: true }));
        break;
      case "beforeinput":
        el.dispatchEvent(new InputEvent("beforeinput", { inputType: s.inputType, data: s.data, isComposing: s.isComposing, bubbles: true, cancelable: true }));
        break;
      case "input": {
        if (s.range) {
          const r = document.createRange();
          r.setStart(...domPoint(el, s.range[0]));
          r.setEnd(...domPoint(el, s.range[1]));
          r.deleteContents();
          const t = document.createTextNode(s.data ?? "");
          if (s.data) r.insertNode(t);
          getSelection()!.collapse(t, t.length);
        }
        el.dispatchEvent(new InputEvent("input", { inputType: s.inputType, data: s.data, isComposing: s.isComposing, bubbles: true }));
        break;
      }
      case "focus":
      case "blur":
        // as the platform reported whether the page had focus, which a headless page always has
        document.hasFocus = () => s.hasFocus;
        if (s.of === "window") window.dispatchEvent(new FocusEvent(s.type));
        else el.dispatchEvent(new FocusEvent(s.type));
        document.hasFocus = hasFocus;
        break;
      case "selection":
        getSelection()!.setBaseAndExtent(...domPoint(el, s.range[0]), ...domPoint(el, s.range[1]));
        break;
    }
  }
}
```

The import path: `web/record.ts` compiles to `record.js` at the site's root. If `npm run check` rejects the `as string` import, use `// @ts-expect-error` with a short reason instead.

- [ ] **Step 2: Write the replay test**

`scenarios/platform/replay.test.ts`:
```ts
// Every trace in scenarios/traces/ replayed into the web app in Chromium, Firefox and WebKit, checked against its row:
// what each platform's input once sent, kept from regressing. Rows still open are todo.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, firefox, webkit, type Browser } from "playwright-core";
import { buildSite, serveStatic } from "../browser.ts";
import { replaySteps, setCaret } from "./replay.ts";
import { rowOf, type Target } from "./rows.ts";
import type { EditorState, Trace } from "../../web/record.ts";

const root = new URL("../..", import.meta.url).pathname;
const PORT = 58563;
const dir = join(root, "scenarios/traces");
const traces: [string, Trace][] = readdirSync(dir, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith(".json"))
  .map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf8"))]);
const engines = { chromium, firefox, webkit };
let site: ReturnType<typeof serveStatic>;
const browsers = new Map<string, Browser>();

before(async () => {
  const out = join(root, "build", "web-replay");
  buildSite(out);
  site = serveStatic(out, PORT);
  for (const [name, engine] of Object.entries(engines)) browsers.set(name, await engine.launch());
});
after(async () => {
  for (const b of browsers.values()) await b.close();
  site?.close();
});

for (const [file, trace] of traces) {
  const row = rowOf(trace.row, trace.variant);
  for (const engine of Object.keys(engines)) {
    test(`${file} in ${engine}: ${row.title}`, { todo: row.open.includes(trace.target as Target) }, async () => {
      const page = await browsers.get(engine)!.newPage({ viewport: { width: 1200, height: 800 } });
      await page.goto(`http://localhost:${PORT}/?demo=edit&record`);
      await page.waitForFunction(() => "breezyRecord" in window && (document.activeElement as HTMLElement | null)?.isContentEditable);
      await page.evaluate(setCaret, trace.before.at);
      const state = () => page.evaluate(async () => ((await import("/record.js" as string)) as typeof import("../../web/record.ts")).editorState());
      const start: EditorState = await state();
      assert.equal(start.text, trace.before.text, "the replay starts from the trace's text");
      await page.evaluate(replaySteps, trace.steps);
      assert.equal(row.expect(start, await state()), null);
      await page.close();
    });
  }
}
```

- [ ] **Step 3: Run it**

Run: `npx playwright-core install chromium webkit firefox && node --test scenarios/platform/replay.test.ts`
Expected: twelve results (4 traces × 3 engines). A2-escape and F1 are `todo` and failing with "no longer edited" in every engine: the replay reproduces the native failure without the native input. A1 and A2-enter are `todo` and fail as they failed natively. If a replay fails differently from its native run, the replayer lacks something the trace shows: compare `build/platform/<row>-<variant>-firefox-mac.json` with what the replay dispatched, and fix `replaySteps` before going on.

- [ ] **Step 4: Run it on every push**

In `.github/workflows/main.yaml`, in the job whose last step is `- name: Scenarios`, add after that step:
```yaml
    - name: Install Chromium, WebKit and Firefox
      run: npx playwright-core install chromium webkit firefox
    - name: Platform rows and trace replays
      run: node --test scenarios/platform/*.test.ts
```
Run: `npx --yes @action-validator/cli .github/workflows/main.yaml` if available. Otherwise check the indentation by eye against the neighbouring steps.

- [ ] **Step 5: Commit**

```bash
git add scenarios/platform/replay.ts scenarios/platform/replay.test.ts .github/workflows/main.yaml
git commit --message "Replay what Firefox on the Mac sent for each row into Chromium, Firefox and WebKit on every push, checking the row, not what happened when it was recorded" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 9: Fix A2, keys while an input method composes

**Files:**
- Create: `web/ime.ts`
- Create: `web/test/ime.test.ts`
- Modify: `web/keys.ts` (`KeyEvent`, `command`)
- Modify: `web/test/keys.test.ts` (the `key` helper and the explicit `command` call)
- Modify: `web/field.ts:148-153` (Enter in a lane's title)
- Modify: `web/ui.ts:62-70` (Escape and Enter in Find)
- Modify: `scenarios/platform/rows.ts` (drop `"firefox-mac"` from A2's `open`)
- Modify: `docs/platform-expectations.md` (A2 status)

**Interfaces:**
- Produces: `composingKey(e: { isComposing: boolean; keyCode: number }): boolean`.

- [ ] **Step 1: Write the failing tests**

`web/test/ime.test.ts`:
```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { composingKey } from "../ime.ts";

test("a key an input method takes is composing, also Safari's Enter after compositionend", () => {
  assert.equal(composingKey({ isComposing: true, keyCode: 27 }), true);
  assert.equal(composingKey({ isComposing: false, keyCode: 229 }), true);
  assert.equal(composingKey({ isComposing: false, keyCode: 13 }), false);
});
```
In `web/test/keys.test.ts`, change the helper so every event carries the new fields:
```ts
const key = (k: string, mods: Partial<KeyEvent> = {}, ctx: { mac?: boolean; typing?: Typing } = {}) =>
  command({ key: k, code: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 0, ...mods }, { mac: true, typing: null, ...ctx });
```
add `isComposing: false, keyCode: 0` to the explicit `command({ key: "=", code: "Digit0", … })` call, and add:
```ts
test("keys an input method is composing with are left to it", () => {
  assert.equal(key("Escape", { isComposing: true }, { typing: "card" }), null);
  assert.equal(key("Tab", { isComposing: true }, { typing: "card" }), null);
  assert.equal(key("Escape", { keyCode: 229 }), null);
  assert.equal(key("Escape", {}, { typing: "card" }), "end-edit");
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `node --test web/test/ime.test.ts web/test/keys.test.ts`
Expected: FAIL, `Cannot find module '../ime.ts'`, and the new keys test failing on `end-edit` ≠ null.

- [ ] **Step 3: Implement**

`web/ime.ts`:
```ts
/**
 * Whether an input method has key event `e`: while it composes, Esc cancels and Enter confirms its text, and neither is
 * the app's. Safari sends the Enter that confirms after compositionend, not composing but with keyCode 229.
 */
export function composingKey(e: { isComposing: boolean; keyCode: number }) {
  return e.isComposing || e.keyCode === 229;
}
```
In `web/keys.ts`:
```ts
import { composingKey } from "./ime.ts";
…
export type KeyEvent = Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "isComposing" | "keyCode">;
…
export function command(e: KeyEvent, { mac, typing }: { mac: boolean; typing: Typing }): Command | null {
  if (composingKey(e)) return null;
```
In `web/field.ts`'s `open`:
```ts
      el.onkeydown = (ev) => {
        if (ev.key !== "Enter" || composingKey(ev)) return;
```
with `import { composingKey } from "./ime.ts";` at the top. In `web/ui.ts`'s Find field listener, first line of the handler:
```ts
      if (composingKey(e)) return;
```
with the same import.

- [ ] **Step 4: Run the unit tests, the check, the replay and the native rows**

Run: `npm test && npm run check && node --test scenarios/platform/replay.test.ts`
Expected: all unit tests pass. If `npm run check` names other callers of `command` that build a `KeyEvent` by hand, give them `isComposing: false, keyCode: 0`. The A2 replays now pass in all three engines; as `todo` tests they report as passing todos. Then remove `"firefox-mac"` from both A2 rows' `open`, run `node --test scenarios/platform/native.e2e.ts`, and expect A2-enter and A2-escape to pass natively. If A2-enter still fails natively, read its trace: Firefox may commit through a path `composeInTitle` or `redrawFront` breaks. Leave it `open` with that cause noted in the catalogue, and fix A2-escape alone.

- [ ] **Step 5: Update the catalogue and commit**

Set A2's status in `docs/platform-expectations.md` to `green on firefox-mac` (or what Step 4 found).
```bash
git add web/ime.ts web/test/ime.test.ts web/keys.ts web/test/keys.test.ts web/field.ts web/ui.ts scenarios/platform/rows.ts docs/platform-expectations.md
git commit --message "Leave Esc, Enter and Tab to an input method while it composes: Esc cancelling Japanese text ended the card's edit, and Enter confirming it in a lane's title or Find ended the rename or stepped the search" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 10: Fix F1, an edit ending when the window loses focus

**Files:**
- Modify: `web/field.ts` (`open`'s `onblur`)
- Modify: `scenarios/platform/rows.ts` (F1's `open`, and A1's if it passes)
- Modify: `docs/platform-expectations.md`

- [ ] **Step 1: Confirm the red test**

Run: `node --test scenarios/platform/replay.test.ts`
Expected: the F1 replays fail as todo with "no longer edited".

- [ ] **Step 2: Implement**

In `web/field.ts`'s `open`, replace `el.onblur = () => on.done();` with:
```ts
    // Focus that leaves the window, for a picker, another app or a notification, comes back to the editor.
    el.onblur = () => document.hasFocus() && on.done();
```

- [ ] **Step 3: Check that ending an edit by clicking elsewhere still works**

Run: `npm test && node --test scenarios/*.test.ts && node --test --test-name-pattern "edit|type|card" scenarios/browsers.e2e.ts`
Expected: all pass. Edits that end by a click on the board or a tap elsewhere still end, because the page keeps focus there.

- [ ] **Step 4: Run the rows**

Remove `"firefox-mac"` from F1's `open`. Run: `node --test scenarios/platform/replay.test.ts && node --test scenarios/platform/native.e2e.ts`
Expected: F1 passes in replay and natively. Then look at A1. If spike 1 found the picker's blur to be the cause, A1 now passes natively: remove `"firefox-mac"` from its `open` and re-record its trace with `RECORD=1`, because the old trace ends with the edit closed, and a replay of a closed edit stays red. If A1 still fails, leave it `open`, write its cause from the trace into the catalogue, and its fix goes into part 2.

- [ ] **Step 5: Update the catalogue and commit**

```bash
git add web/field.ts scenarios/platform/rows.ts scenarios/traces/firefox-mac docs/platform-expectations.md
git commit --message "Keep editing a card while focus leaves the window for a moment, as for the emoji picker, another app or a notification: the edit ended and what the picker sent went nowhere" --message "Claude-Session: https://claude.ai/code/session_013QZH3mNSYjBPto8LfQHBSb"
```

---

### Task 11: Close part 1

- [ ] **Step 1: Run everything this part touches**

Run: `npm run check && npm test && node --test scenarios/*.test.ts scenarios/platform/*.test.ts && node --test scenarios/platform/oskeys.e2e.ts scenarios/platform/native.e2e.ts`
Expected: everything passes; open rows report as todo.

- [ ] **Step 2: Hand over**

Tell your human partner: which rows are green, which are open and why, the spike results, and that part 2, the remaining `firefox-mac` rows, needs its own plan.
