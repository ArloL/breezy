// Reading a space's recordings back with its own token, from an invite link given at run time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { targetOf } from "../diag.ts";
import { inviteLink, SpaceKeys } from "../../web/sync/crypto.ts";
import { decode, encode } from "../../web/sync/base64.ts";

test("an invite link names the space's server, the space and the token its devices sync with", async () => {
  const space = encode(randomBytes(16)), secret = encode(randomBytes(32));
  const t = await targetOf(`look: ${inviteLink({ server: "https://breezy.k5d.de/sync.php", space, secret, name: "Home" })} thanks`);
  const keys = await SpaceKeys.create(decode(space)!, decode(secret)!);
  assert.deepEqual(t, { server: "https://breezy.k5d.de/sync.php", space, token: encode(keys.token) });
});

test("text without an invite link is refused", async () => {
  await assert.rejects(targetOf("no link here"), /no invite link/);
});
