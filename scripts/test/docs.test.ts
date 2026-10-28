// TESTING.md and docs/escapes.md stay true to the repo: the paths they name exist, the matrix's plants are planted, and
// each escape is a row the counts can read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLANTS } from "../plants.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(join(root, path), "utf8");

/** The rows of the first table after `heading`, or of the file's first table, without header and separator. */
function table(text: string, heading?: string): string[][] {
  const from = heading ? text.indexOf(`\n${heading}\n`) : 0;
  assert.ok(from >= 0, `no ${heading}`);
  const lines = text.slice(from).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const l of lines.slice(start)) {
    if (!l.startsWith("|")) break;
    rows.push(l.slice(1, l.lastIndexOf("|")).split("|").map((c) => c.trim()));
  }
  return rows.filter((r, i) => i > 0 && !r.every((c) => /^-+$/.test(c)));
}

const CLASSES = ["B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"];
/** Escapes before this were seeded from commit messages. */
const SEEDED = "2026-10-25";
/** Escapes since this say what signal pinned them. */
const FACTS_FIRST = "2026-10-28";
const isFile = (path: string) => path !== "" && existsSync(join(root, path)) && statSync(join(root, path)).isFile();

function files(dir: string, ext: string): string[] {
  return readdirSync(join(root, dir), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(ext) && !f.includes("node_modules"))
    .map((f) => join(dir, f));
}

test("every path TESTING.md names exists", () => {
  for (const [, token] of read("TESTING.md").matchAll(/`([^`\s]+)`/g)) {
    const path = token.replace(/:\d+$/, "");
    if (!/^[\w.-]+(\/[\w.*-]+)+\/?$/.test(path) && !/\.(md|ts|swift|sh|py|yaml|mjs)$/.test(path)) continue;
    const at = path.includes("*") ? dirname(path) : path;
    assert.ok(existsSync(join(root, at)), `TESTING.md names ${token}, which does not exist`);
  }
});

test("the matrix has a row per class and a valid cell per level", () => {
  const rows = table(read("TESTING.md"), "## Matrix");
  assert.deepEqual(rows.map((r) => r[0]), CLASSES);
  for (const [c, ...cells] of rows) {
    assert.equal(cells.length, 8, `${c} has ${cells.length} levels`);
    for (const cell of cells) assert.match(cell, /^(—|claimed|plant: [a-z0-9-]+(, [a-z0-9-]+)*)$/, `${c}: ${cell}`);
  }
});

test("every plant the matrix names is planted in the source", () => {
  // the app's code, or for a deploy, the check that serves the site as built
  const source = [...files("web", ".ts"), ...files("BreezyKit/Sources", ".swift"), "scripts/deploy-check.ts"].map(read).join("\n");
  for (const [c, ...cells] of table(read("TESTING.md"), "## Matrix")) {
    for (const cell of cells.filter((x) => x.startsWith("plant: "))) {
      for (const name of cell.slice("plant: ".length).split(",").map((n) => n.trim())) {
        assert.ok(source.includes(`planted("${name}")`), `${c} names plant ${name}, planted nowhere`);
      }
    }
  }
});

test("the matrix's plants and scripts/plants.ts's are the same, at the same class and level", () => {
  const [, ...levels] = read("TESTING.md").split("\n").find((l) => l.startsWith("| Class |"))!.slice(1, -1).split("|").map((c) => c.trim());
  const matrix = new Set<string>();
  for (const [c, ...cells] of table(read("TESTING.md"), "## Matrix")) {
    cells.forEach((cell, i) => {
      if (cell.startsWith("plant: ")) for (const name of cell.slice("plant: ".length).split(", ")) matrix.add(`${name} ${c} ${levels[i]}`);
    });
  }
  assert.deepEqual([...matrix].sort(), PLANTS.map((p) => `${p.plant} ${p.class} ${p.level}`).sort());
});

test("every escape row is well formed", () => {
  const text = read("docs/escapes.md");
  const header = text.split("\n").find((l) => l.startsWith("|"));
  assert.equal(header, "| Date | Platform | Class | Found by | Should have caught | Test | Signal | Interventions | Recorded | Commit |");
  const rows = table(text);
  assert.ok(rows.length > 0, "no escapes");
  for (const r of rows) {
    const [date, platform, cls, found, level, t, signal, interventions, recorded, commit] = r;
    const row = r.join(" | ");
    assert.equal(r.length, 10, row);
    // what pinned the cause, how often the owner had to step in after the report, and whether it was recorded anyway:
    // the measure of debugging from facts (docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md)
    assert.match(interventions, /^(\d+|—|unstated)$/, row);
    assert.match(recorded, /^(yes|no|—|unstated)$/, row);
    if (date < SEEDED) assert.deepEqual([signal, interventions, recorded], ["—", "—", "—"], `${row}: a seeded row has no signal`);
    if (date >= FACTS_FIRST) assert.ok(signal.length > 1 && /^\d+$/.test(interventions) && /^(yes|no)$/.test(recorded), `${row}: an escape logged since ${FACTS_FIRST} says what pinned it`);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, row);
    assert.ok(["mac", "ios", "android", "web", "firefox", "chromium", "webkit"].includes(platform), row);
    assert.ok(CLASSES.includes(cls), row);
    assert.ok(found.length > 0, row);
    assert.match(level, /^L[1-8]$/, row);
    // a seeded row's test was not traced; one logged since names its test, or says it is still to come
    if (t === "—") assert.ok(date < SEEDED, `${row}: an escape logged since ${SEEDED} names its test`);
    else assert.ok(t === "pending" || isFile(t.replace(/^`|`$/g, "")), `${row}: test ${t} is no file`);
    if (commit === "—") assert.equal(t, "pending", `${row}: only an open escape has no commit`);
    // or its pull request, whose commits a rebase merge gives new hashes
    else if (!/^#\d+$/.test(commit)) execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
  }
});
