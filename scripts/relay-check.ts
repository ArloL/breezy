#!/usr/bin/env node
// That the relay at RELAY (production's by default) takes a connection, for a deploy that broke it to fail where it
// happened: node scripts/relay-check.ts [RELAY]. The space is new and the connection never signs in, so the relay keeps
// nothing of it.
import { randomBytes } from "node:crypto";

const relay = process.argv[2] ?? "wss://breezy-relay.blissfulbird.workers.dev/";
const opens = () => new Promise<void>((resolve, reject) => {
  const ws = new WebSocket(`${relay}?space=${randomBytes(16).toString("base64url")}`);
  const timer = setTimeout(() => reject(new Error("no answer in 15 s")), 15_000);
  ws.onopen = () => {
    clearTimeout(timer);
    ws.close();
    resolve();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    reject(new Error("the connection failed"));
  };
});
for (let attempt = 1; ; attempt++) {
  try {
    await opens();
    console.log(`${relay} takes connections`);
    break;
  } catch (e) {
    if (attempt === 4) throw new Error(`${relay} takes no connections: ${(e as Error).message}`);
    await new Promise((r) => setTimeout(r, 3000 * attempt));
  }
}
