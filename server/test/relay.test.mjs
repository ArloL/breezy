import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

// sync.php on a server of its own whose config names a relay; the other tests run without one
const here = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "breezy-relay-"));
const db = join(dir, "test.db");
execFileSync("php", ["-r", '$db = new PDO("sqlite:" . $argv[1]); $db->exec(file_get_contents($argv[2]));', db, join(here, "schema.sql")]);
writeFileSync(join(dir, "config.php"), `<?php return ['dsn' => 'sqlite:${db}', 'relay' => 'wss://relay.example/'];`);
const php = spawn("php", ["-S", "127.0.0.1:58567", "-t", here], { env: { ...process.env, BREEZY_CONFIG: join(dir, "config.php") }, stdio: "ignore" });
after(() => {
  php.kill();
  rmSync(dir, { recursive: true, force: true });
});

const rand = (n) => randomBytes(n).toString("base64url");

async function call(method, space, token, body) {
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:58567/sync.php?space=${space}&since=0`, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: body && JSON.stringify(body),
      });
      return await res.json();
    } catch (error) {
      if (i > 50) throw error;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

test("responses name the relay when the config does", async () => {
  const space = rand(16), token = rand(32);
  assert.equal((await call("GET", space, token)).relay, "wss://relay.example/");
  const pushed = await call("POST", space, token, { writes: [{ id: rand(16), base: 0, blob: rand(40) }] });
  assert.equal(pushed.relay, "wss://relay.example/");
  assert.equal(pushed.accepted.length, 1);
});
