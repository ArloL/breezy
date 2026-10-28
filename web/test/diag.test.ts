// Sending what the app recorded to the space's server: by hand, or on an error or a broken sight at most once in 10
// minutes, never more than the server takes, and never throwing into the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { diagUrl, LIMIT, Reporter, send, type Target } from "../diag.ts";
import type { Recording } from "../flight.ts";

const target: Target = { server: "https://breezy.k5d.de/sync.php", space: "c3BhY2U", token: "dG9rZW4" };
const recording = (n: number): Recording => ({
  schema: 1, origin: 0, dropped: 0, context: null,
  entries: Array.from({ length: n }, (_, i) => [i, "decision", "reveal", { path: "card", why: "fits", editing: { card: [i, i, 240, 48] } }]),
});

/** A fetch that keeps what it was asked and answers `status`. */
const fetcher = (status = 200) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { calls, f };
};

const body = async (init: RequestInit) => {
  const b = init.body as ArrayBuffer | string;
  return JSON.parse(typeof b === "string" ? b : inflateRawSync(Buffer.from(b)).toString());
};

test("sends to diag.php beside the space's sync.php, with its token", async () => {
  assert.equal(diagUrl("https://breezy.k5d.de/sync.php"), "https://breezy.k5d.de/diag.php");
  const { calls, f } = fetcher();
  assert.equal(await send(target, "asked", recording(3), { fetch: f }), true);
  assert.equal(calls[0]!.url, "https://breezy.k5d.de/diag.php?space=c3BhY2U");
  assert.equal((calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer dG9rZW4");
  const b = await body(calls[0]!.init);
  assert.equal(b.why, "asked");
  assert.equal(b.recording.entries.length, 3);
});

test("sends the newest entries that fit what the server takes, saying how many it left out", async () => {
  const { calls, f } = fetcher();
  await send(target, "asked", recording(8000), { fetch: f });
  const b = await body(calls[0]!.init);
  assert.ok(JSON.stringify(b).length <= LIMIT, `${JSON.stringify(b).length} bytes`);
  assert.equal(b.recording.entries.at(-1)[0], 7999);
  assert.equal(b.recording.dropped, 8000 - b.recording.entries.length);
});

test("a send that fails says so and never throws", async () => {
  const rejecting = (async () => { throw new TypeError("offline"); }) as unknown as typeof fetch;
  assert.equal(await send(target, "asked", recording(1), { fetch: rejecting }), false);
  assert.equal(await send(target, "asked", recording(1), { fetch: fetcher(429).f }), false);
});

test("sends on an error at most once in 10 minutes, and whenever asked", async () => {
  let now = 0;
  const sent: string[] = [];
  const r = new Reporter(() => target, () => recording(1), { now: () => now, send: async (_t, why) => (sent.push(why), true) });
  await r.report("error");
  await r.report("error");
  now += 9 * 60_000;
  await r.report("error");
  await r.report("asked");
  now += 60_000;
  await r.report("error");
  assert.deepEqual(sent, ["error", "asked", "error"]);
});

test("sends nothing where no space has a server", async () => {
  const r = new Reporter(() => null, () => recording(1), { send: async () => assert.fail("sent") });
  assert.equal(await r.report("asked"), false);
});
