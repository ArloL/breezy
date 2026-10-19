// tools/oskeys against its echo app. Takes over this Mac's keyboard for a minute; needs Accessibility for the terminal.
//   node --test scenarios/platform/oskeys.e2e.ts
import { before, test } from "node:test";
import assert from "node:assert/strict";
import { buildOskeys, Echo, oskeys, restoreSourceOnExit, trusted } from "./oskeys.ts";

if (process.platform === "darwin") buildOskeys();
const skip = process.platform !== "darwin" ? "macOS only" : !trusted() && "the terminal lacks Accessibility permission";
/** Runs `body` with a fresh echo app, stopped even when `body` fails, else it keeps the run from ending. */
async function withEcho(body: (echo: Echo) => Promise<void>, source?: string) {
  const echo = await Echo.start(source);
  try {
    await body(echo);
  } finally {
    echo.stop();
  }
}

before(() => {
  if (skip) return;
  restoreSourceOnExit(oskeys(["source"]));
  oskeys(["source", "com.apple.keylayout.ABC"]);
});

test("keys reach the frontmost text view", { skip }, async () => withEcho(async (echo) => {
  oskeys(["type", "Plan"], echo.pid);
  await echo.until("Plan", (l) => l.string === "Plan");
  oskeys(["key", "left", "opt"], echo.pid);
  await echo.until("⌥← as a command", (l) => l.selector === "moveWordLeft:");
}));

test("refuses to type while another process is frontmost", { skip }, async () => withEcho(async () => {
  assert.throws(() => oskeys(["type", "x"], 1));
}));

// live conversion may mark にほん or 日本
test("Kotoeri composes, Return commits", { skip }, async () => {
  try {
    await withEcho(async (echo) => {
      oskeys(["type", "nihonn"], echo.pid);
      await echo.until("にほん or 日本 marked", (l) => l.call === "setMarkedText" && /^(にほん|日本)$/.test(l.text!));
      oskeys(["key", "return"], echo.pid);
      await echo.until("it committed", (l) => !l.marked && /^(にほん|日本)$/.test(l.string));
    }, "com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese");
  } finally {
    oskeys(["source", "com.apple.keylayout.ABC"]);
  }
});

test("the emoji picker inserts the first match", { skip }, async () => withEcho(async (echo) => {
  oskeys(["emoji", "grinning"], echo.pid);
  await echo.until("an emoji", (l) => /^\p{Extended_Pictographic}$/u.test(l.string));
}));

test("away and back keeps the text view the keyboard's", { skip }, async () => withEcho(async (echo) => {
  oskeys(["away", String(echo.pid)]);
  oskeys(["type", "x"], echo.pid);
  await echo.until("x", (l) => l.string === "x");
}));
