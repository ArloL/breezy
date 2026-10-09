import { test } from "node:test";
import assert from "node:assert/strict";
import { SpaceKeys, randomBytes, inviteLink, parseInvite, validServer, INVITE_PREFIX } from "../sync/crypto.js";
import { encode, decode } from "../sync/base64.js";
import { fixture } from "./helpers/fixture.js";

const v = fixture("crypto.json");
const enc = new TextEncoder();

test("encryption matches the shared vector", async () => {
  const keys = await SpaceKeys.create(decode(v.space), decode(v.secret));
  assert.equal(encode(keys.token), v.token);
  assert.equal(encode(new Uint8Array(await crypto.subtle.digest("SHA-256", keys.token))), v.tokenHash);
  assert.equal(encode(await keys.seal(enc.encode(v.plaintext), decode(v.id), decode(v.nonce))), v.blob);
  assert.equal(new TextDecoder().decode(await keys.open(decode(v.blob), decode(v.id))), v.plaintext);
});

test("a blob moved to another record does not open", async () => {
  const keys = await SpaceKeys.create(randomBytes(16), randomBytes(32));
  const blob = await keys.seal(enc.encode("x"), randomBytes(16));
  await assert.rejects(keys.open(blob, randomBytes(16)));
});

test("invites go to links and back", () => {
  const invite = { server: v.server, space: v.space, secret: v.secret };
  assert.deepEqual(parseInvite(v.invite), invite);
  assert.equal(inviteLink(invite), v.invite);
  assert.ok(v.invite.startsWith(INVITE_PREFIX));
});

test("a pasted invite may have text around it", () => {
  assert.deepEqual(parseInvite(`Join me: ${v.invite}).\n`), { server: v.server, space: v.space, secret: v.secret });
});

test("what is not an invite is refused", () => {
  for (const text of [
    "", "https://breezy.k5d.de/", "https://breezy.k5d.de/#join=abc",
    inviteLink({ server: "ftp://example.com", space: v.space, secret: v.secret }),
    inviteLink({ server: v.server, space: "AAAA", secret: v.secret }),
    inviteLink({ server: v.server, space: v.space, secret: "AAAA" }),
  ]) assert.equal(parseInvite(text), null, text);
});

test("servers must be https or this computer", () => {
  assert.ok(validServer("https://example.com/breezy/sync.php"));
  assert.ok(validServer("http://localhost:58566/sync.php"));
  assert.ok(validServer("http://127.0.0.1:58566/sync.php"));
  assert.ok(!validServer("http://example.com/sync.php"));
  assert.ok(!validServer("example.com"));
  assert.ok(!validServer(""));
});

test("an invite may name its space", () => {
  const named = { server: v.server, space: v.space, secret: v.secret, name: "Home & Work" };
  assert.equal(inviteLink(named), v.namedInvite);
  assert.deepEqual(parseInvite(v.namedInvite), named);
  assert.equal("name" in parseInvite(v.invite), false);
});
