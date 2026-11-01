// The agent's channel to the iPhone's page, which asks for a function at a time: a poll lost between them loses no function.
// On CI's runner the page asked, the server sent createBoard's first function to a poll the page never read, and the
// page asked nothing more until its open poll ran out 10 s later.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "./agent.ts";

setTimeout(() => process.exit(1), 30_000).unref();

async function serve() {
  const agent = new Agent();
  const server: Server = createServer((req, res) => void agent.handle(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { agent, base, stop: () => (agent.stop(), server.closeAllConnections(), server.close()) };
}

/** A poll whose answer never reaches the page: sent, and its response never read. */
function lostPoll(base: string, page: string) {
  request(`${base}/agent/next?page=${page}&visible=true&last=0`).on("error", () => {}).end();
}

/** The page asking, with the last function it got, and running what it is given. */
async function poll(base: string, page: string, last: number) {
  const r = await fetch(`${base}/agent/next?page=${page}&visible=true&last=${last}`);
  const { seq, src, arg } = await r.json() as { seq: number; src: string; arg: unknown };
  const value = await (0, eval)(`(${src})`)(arg);
  await fetch(`${base}/agent/result`, { method: "POST", body: JSON.stringify({ seq, value }) });
  return seq;
}

const settle = () => new Promise((r) => setTimeout(r, 100));

test("a function goes to the page's newest poll, not one it asked before and never read", async () => {
  const { agent, base, stop } = await serve();
  try {
    lostPoll(base, "p");
    await settle();
    const asked = poll(base, "p", 0);
    await settle();
    assert.equal(await agent.run(((n: number) => n + 1).toString(), 41, 3000), 42);
    await asked;
  } finally {
    stop();
  }
});

test("a function sent on a poll that never reached the page goes again on its next", async () => {
  const { agent, base, stop } = await serve();
  try {
    lostPoll(base, "p");
    await settle();
    const ran = agent.run(((n: number) => n + 1).toString(), 41, 3000);
    await settle();
    await poll(base, "p", 0);
    assert.equal(await ran, 42);
  } finally {
    stop();
  }
});

test("a function the page got is not sent again", async () => {
  const { agent, base, stop } = await serve();
  try {
    const first = poll(base, "p", 0);
    await settle();
    assert.equal(await agent.run(((n: number) => n + 1).toString(), 1, 3000), 2);
    const seq = await first;
    const next = poll(base, "p", seq);
    await settle();
    assert.equal(await agent.run(((n: number) => n * 2).toString(), 21, 3000), 42);
    assert.equal(await next, seq + 1);
  } finally {
    stop();
  }
});
