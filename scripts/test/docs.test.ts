// TESTING.md and docs/escapes.md stay true to the repo: the paths they name exist, the matrix's plants are planted, and
// each escape is a row the counts can read.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  const source = [...files("web", ".ts"), ...files("BreezyKit/Sources", ".swift")].map(read).join("\n");
  for (const [c, ...cells] of table(read("TESTING.md"), "## Matrix")) {
    for (const cell of cells.filter((x) => x.startsWith("plant: "))) {
      for (const name of cell.slice("plant: ".length).split(",").map((n) => n.trim())) {
        assert.ok(source.includes(`planted("${name}")`), `${c} names plant ${name}, planted nowhere`);
      }
    }
  }
});

test("every escape row is well formed", () => {
  const text = read("docs/escapes.md");
  const header = text.split("\n").find((l) => l.startsWith("|"));
  assert.equal(header, "| Date | Platform | Class | Found by | Should have caught | Test | Commit |");
  const rows = table(text);
  assert.ok(rows.length > 0, "no escapes");
  for (const r of rows) {
    const [date, platform, cls, found, level, t, commit] = r;
    const row = r.join(" | ");
    assert.equal(r.length, 7, row);
    assert.match(date, /^\d{4}-\d{2}-\d{2}$/, row);
    assert.ok(["mac", "ios", "android", "web", "firefox", "chromium", "webkit"].includes(platform), row);
    assert.ok(CLASSES.includes(cls), row);
    assert.ok(found.length > 0, row);
    assert.match(level, /^L[1-8]$/, row);
    // a seeded row's test was not traced; one logged since names its test, or says it is still to come
    if (t === "—") assert.ok(date < SEEDED, `${row}: an escape logged since ${SEEDED} names its test`);
    else assert.ok(t === "pending" || isFile(t.replace(/^`|`$/g, "")), `${row}: test ${t} is no file`);
    if (commit === "—") assert.equal(t, "pending", `${row}: only an open escape has no commit`);
    else execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: root, stdio: "ignore" });
  }
});
