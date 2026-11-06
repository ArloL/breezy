// A case's timeline notes of requests to the servers: a report is no push.
import { test } from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";
import { answerNote, isReport, sentNote } from "./sync-log.ts";

setTimeout(() => process.exit(1), 10_000).unref();

const SERVER = "http://127.0.0.1:8000/";

test("a report of the recording is noted with its why, not as a push", () => {
  const body = deflateRawSync(JSON.stringify({ why: "sight", recording: { schema: 1, origin: 0, dropped: 0, context: null, entries: [[1, "life", "shown"], [2, "decision", "sight broken"]] } }));
  const url = `${SERVER}diag.php?space=S`;
  assert.equal(isReport(url), true);
  assert.equal(sentNote(url, body, "deflate"), "report sight, 2 entries");
});

test("a push is noted with its writes, and its answer with the records", () => {
  const url = `${SERVER}sync.php?space=S`;
  assert.equal(isReport(url), false);
  const body = Buffer.from(JSON.stringify({ since: 4, epoch: "e", writes: [{ id: "abcdefghij", base: 3 }] }));
  assert.equal(sentNote(url, body), "push since 4 epoch e writes abcdefgh@3");
  assert.equal(answerNote(200, { accepted: [{ id: "abcdefghij", version: 4 }], cursor: 5, epoch: "e" }), "  200 accepted abcdefgh@4 refused  records  cursor 5 epoch e");
});

test("a body that does not read says so, and what it was sent as", () => {
  assert.match(sentNote(`${SERVER}diag.php`, Buffer.from("{")), /^report, its body unread: SyntaxError/);
  assert.match(sentNote(`${SERVER}sync.php`, Buffer.from("{")), /^push, its body unread: SyntaxError/);
});
