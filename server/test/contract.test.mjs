// The unit tests' FakeServer held to sync.php: seeded random calls, through the app's own HttpTransport, answered alike
// by both (web/test/helpers/server-contract.ts). With BREEZY_CONTRACT, the calls and the real answers are written there
// for BreezyKit's fake to be held to them too (ServerContractTests.swift).
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { HttpTransport } from "../../web/sync/engine.ts";
import { fakeSide, generator, Player } from "../../web/test/helpers/server-contract.ts";

const URL_ = process.env.BREEZY_URL;
const SEEDS = Number(process.env.CONTRACT_SEEDS ?? 20), STEPS = Number(process.env.CONTRACT_STEPS ?? 40);
const b64 = (bytes) => Buffer.from(bytes).toString("base64url");

/** `sql`, its statements split at ";", on `space`, straight to sync.php's database; needs BREEZY_CONFIG. */
function onDatabase(sql, space) {
  // the space after --: a random one starts with "-" one time in 64, which php would take for an option
  execFileSync("php", ["-r", `
    $c = require getenv("BREEZY_CONFIG");
    $db = new PDO($c["dsn"], $c["user"] ?? null, $c["password"] ?? null);
    $space = base64_decode(strtr($argv[1], "-_", "+/") . "==");
    foreach (explode(";", $argv[2]) as $q) {
      $st = $db->prepare($q);
      $st->bindValue(1, $space, PDO::PARAM_LOB);
      $st->execute();
    }`, "--", space, sql]);
}

/** sync.php as a side, in a space of its own. */
function realSide() {
  const space = b64(randomBytes(16));
  const transport = new HttpTransport(URL_, space, b64(randomBytes(32)));
  return {
    pull: (since) => transport.pull(since),
    push: (writes, since, epoch) => transport.push(writes, since, epoch),
    // a new epoch, as the README says to give a restored backup; server/test.sh's database is SQLite
    restore: async () => onDatabase("UPDATE spaces SET epoch = randomblob(16) WHERE id = ?", space),
    wipe: async () => onDatabase("DELETE FROM records WHERE space = ?;DELETE FROM spaces WHERE id = ?", space),
  };
}

test("the unit tests' FakeServer answers as sync.php does", { skip: !URL_ && "run by server/test.sh" }, async () => {
  const runs = [];
  /** What the answers reached, which the calls are only worth as much as. */
  const reached = new Set();
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = generator(seed), real = new Player(realSide()), fake = new Player(fakeSide());
    const steps = [];
    for (let i = 0; i < STEPS; i++) {
      const step = g.next();
      const r = await real.play(step), f = await fake.play(step);
      g.saw(step, r.answer);
      steps.push({ step, answer: r.normal });
      const a = r.answer;
      if (a?.refused?.length) reached.add("a write refused");
      if ([...(a?.refused ?? []), ...(a?.records ?? [])].some((x) => x.stale)) reached.add("a stale record");
      if (a?.records?.length === 500) reached.add("a full page");
      if (step.op === "push" && step.epoch && a.accepted.length === 0 && a.refused.length === 0 && a.cursor === undefined) reached.add("a push refused for its epoch");
      if (a && a.epoch === null) reached.add("no space");
      // with the steps that led there, each cut short, as a page's push is long
      const said = (s) => JSON.stringify(s, (k, v) => (k === "blob" ? `${v.slice(0, 6)}…` : v)).slice(0, 400);
      assert.deepEqual(f.normal, r.normal, `seed ${seed}, step ${i}, after:\n${steps.slice(-6, -1).map((s) => `${said(s.step)}\n  → ${said(s.answer)}`).join("\n")}\n${said(step)}`);
    }
    runs.push({ seed, steps });
  }
  assert.deepEqual([...reached].sort(), ["a full page", "a push refused for its epoch", "a stale record", "a write refused", "no space"]);
  if (process.env.BREEZY_CONTRACT) writeFileSync(process.env.BREEZY_CONTRACT, JSON.stringify(runs));
});
