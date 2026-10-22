#!/usr/bin/env node
// Firefox for Android as Playwright's moz-firefox channel launches it: given as executablePath, it starts Firefox on the
// emulator with WebDriver BiDi on, and prints the line Playwright waits for, pointing at a proxy that
// answers what Firefox for Android does not implement. Playwright's arguments, for a desktop Firefox, are ignored.
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { setTimeout as sleep } from "node:timers/promises";
import { EMULATOR_TCP, FENIX, FENIX_BIDI, RELAY, SERVER, WEB } from "./browser.ts";

const serial = process.env.FENIX_SERIAL ?? EMULATOR_TCP;
const adb = (...args: string[]) => execFileSync("adb", ["-s", serial, ...args], { encoding: "utf8", timeout: 30_000, stdio: "pipe" });

const stop = () => {
  try {
    adb("shell", "am", "force-stop", FENIX);
    adb("forward", "--remove", `tcp:${FENIX_BIDI}`);
  } catch {}
};

stop();
// GeckoView reads its arguments from here when it is the debug app
execFileSync("adb", ["-s", serial, "shell", `cat > /data/local/tmp/${FENIX}-geckoview-config.yaml`], {
  timeout: 30_000,
  input: [
    "args:", "  - --remote-debugging-port", `  - "${FENIX_BIDI}"`,
    "env:", '  MOZ_CRASHREPORTER: "1"', '  MOZ_CRASHREPORTER_NO_REPORT: "1"',
    // as a person allows it the first time: else Firefox asks over the page as the app asks for persistent storage
    "prefs:", "  dom.storageManager.prompt.testing: true", "  dom.storageManager.prompt.testing.allow: true",
    // drawn without GL: on CI's emulator, GL through SwiftShader deadlocked the display as the keyboard came up
    "  gfx.webrender.software: true", "",
  ].join("\n"),
});
// Android has one debug app, which Chrome's launch takes too
adb("shell", "am", "set-debug-app", "--persistent", FENIX);
const start = () => adb("shell", "am", "start", "-W", "-a", "android.intent.action.VIEW", "-d", "about:blank", "-n", `${FENIX}/org.mozilla.fenix.IntentReceiverActivity`);
try {
  start();
} catch {
  // a start that failed once in a soak, after Android ended Firefox behind Chrome: once more, from stopped
  stop();
  start();
}
// Firefox checks the Host header against its own port, so the port is the same on both ends
adb("forward", `tcp:${FENIX_BIDI}`, `tcp:${FENIX_BIDI}`);
const upstream = `ws://127.0.0.1:${FENIX_BIDI}/session`;
for (const end = Date.now() + 30_000; ; await sleep(250)) {
  if (await fetch(`http://127.0.0.1:${FENIX_BIDI}/`).then(() => true, () => false)) break;
  if (Date.now() > end) throw new Error(`Firefox did not open WebDriver BiDi on ${serial} in 30 s`);
}

/** Commands Firefox for Android fails, done here instead. */
const answered: Record<string, (params: Record<string, unknown>) => void> = {
  // fails on GeckoView's tabs; the scenarios download nothing
  "browser.setDownloadBehavior": () => {},
  // the page has the phone's size
  "browsingContext.setViewport": () => {},
  // fails on GeckoView's tabs: the page loses this machine's servers instead, as a phone loses the network
  "emulation.setNetworkConditions": ({ networkConditions }) => {
    for (const port of [WEB, SERVER, RELAY]) {
      if (networkConditions) adb("reverse", "--remove", `tcp:${port}`);
      else adb("reverse", `tcp:${port}`, `tcp:${port}`);
    }
  },
};

interface Socket {
  readyState: number;
  send(m: string): void;
  close(): void;
  on(event: "open" | "close", f: () => void): void;
  on(event: "message", f: (m: Buffer) => void): void;
}
// Playwright's own WebSocket library, which it exports untyped
const { ws: WebSocket, wsServer: WebSocketServer } = createRequire(import.meta.url)("playwright-core/lib/utilsBundle") as {
  ws: { new (url: string): Socket; OPEN: number };
  wsServer: new (o: { host: string; port: number }) => { on(e: "connection", f: (s: Socket) => void): void; once(e: "listening", f: () => void): void; address(): { port: number } };
};

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
server.on("connection", (client) => {
  const firefox = new WebSocket(upstream);
  const queue: string[] = [];
  firefox.on("open", () => queue.splice(0).forEach((m) => firefox.send(m)));
  firefox.on("message", (m) => client.send(m.toString()));
  firefox.on("close", () => client.close());
  client.on("close", () => firefox.close());
  client.on("message", (m) => {
    const text = m.toString();
    const { id, method, params } = JSON.parse(text);
    if (method in answered) {
      answered[method]!(params);
      return client.send(JSON.stringify({ type: "success", id, result: {} }));
    }
    // Firefox on Android stays open, and Playwright waits for this process to end
    if (method === "browser.close") {
      client.send(JSON.stringify({ type: "success", id, result: {} }));
      stop();
      process.exit(0);
    }
    if (firefox.readyState === WebSocket.OPEN) firefox.send(text);
    else queue.push(text);
  });
});
await new Promise<void>((resolve) => server.once("listening", resolve));
console.log(`WebDriver BiDi listening on ws://127.0.0.1:${server.address().port}`);

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.on(signal, () => {
  stop();
  process.exit(0);
});
