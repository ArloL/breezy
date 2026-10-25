# Testing strategy, step 1: the frame — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `TESTING.md` with the bug classes, levels and today's matrix; `docs/escapes.md` seeded from history; the escape rule in `CLAUDE.md`; the iPhone in the quality goals — kept honest by a test on every push.

**Architecture:** Documents plus one `node:test` file that parses them: every path `TESTING.md` names exists, every matrix cell follows the grammar and every plant it names exists in source, every escape row is well formed. `npm test` runs it, so Main's `web` job guards it.

**Tech Stack:** Markdown, TypeScript run by Node 24's `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-25-breezy-testing-strategy-design.md`

## Global Constraints

- Classes are exactly B1–B8 and levels exactly L1–L8 as the spec names them; `Hand` is not a level.
- The matrix shows today, empty cells included; nothing is claimed owned without a plant.
- Plants are switched on by name: `planted("name")` in `web/sync/plant.ts`, `planted("name")` in `BreezyKit/Sources/BreezyKit/Plant.swift`, set by `BREEZY_PLANT` / `globalThis.__breezyPlant`.
- No new dependencies. Prose in the repo's voice: plain sentences, no headings beyond what a reader skims.
- Branch `testing-strategy` (exists). Commits end with `Claude-Session: https://claude.ai/code/session_01WjCKBwgpJMWYywtHYsPaX7`.

## Review Focus

1. A path in `TESTING.md` written with a line suffix (`scenarios/ios.ts:164`) or a glob (`web/test/*.test.ts`) — strip `:N`; a glob counts if its directory exists.
2. A plant named in the matrix that exists only in Swift, or only in the web — either counts.
3. A matrix cell with extra spaces or a trailing comma in a plant list — trim, and reject an empty name.
4. An escape row whose commit is `—` (not yet fixed, like the open iOS bug) — allowed when Test is `pending`.
5. The table separator row (`|---|`) and the header row must not be parsed as data.

---

### Task 1: The docs test

**Files:**
- Create: `scripts/test/docs.test.ts`
- Modify: `scripts/tsconfig.json` (add `"test/**/*.ts"` to `include`)
- Modify: `package.json` (`"test": "node --test web/test/*.test.ts scripts/test/*.test.ts"`)

**Interfaces:**
- Produces: the formats Tasks 2 and 3 must write.
  - `TESTING.md` has a `## Matrix` section whose first table has header `| Class | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 |` and rows `B1`…`B8` in order; a cell is `—`, `claimed`, or `plant: name[, name…]`.
  - `docs/escapes.md` has one table with header `| Date | Platform | Class | Found by | Should have caught | Test | Commit |`. Date `YYYY-MM-DD`; Platform one of `mac`, `ios`, `android`, `web`, `firefox`, `chromium`, `webkit`; Class `B1`–`B8`; Found by free text; Should have caught `L1`–`L8`; Test an existing repo path, `—`, or `pending`; Commit a short hash `git cat-file -e` accepts, or `—` only when Test is `pending`.

- [ ] **Step 1: Write the failing tests** in `scripts/test/docs.test.ts`, reading files relative to the repo root (`new URL("../../", import.meta.url)`):
  - `test("every path TESTING.md names exists")`: collect backticked tokens matching `/^[\w.-]+(\/[\w.*-]+)+(:\d+)?$/` or ending in `.md|.ts|.swift|.sh|.py|.yaml|.mjs`; strip `:N`; for a token containing `*`, assert its directory exists; else `existsSync`. Message names the missing path.
  - `test("the matrix has a row per class and a valid cell per level")`: rows equal `["B1",…,"B8"]`; each has 8 cells; each cell matches `/^(—|claimed|plant: [a-z0-9-]+(, [a-z0-9-]+)*)$/` after trim.
  - `test("every plant the matrix names is planted in the source")`: for each name, assert `planted("name")` occurs in some file under `web/` (`.ts`) or `BreezyKit/Sources/` (`.swift`).
  - `test("every escape row is well formed")`: per the Interfaces above; commit checked with `execFileSync("git", ["cat-file", "-e", hash + "^{commit}"])`.

- [ ] **Step 2: Run to see them fail**

Run: `node --test scripts/test/docs.test.ts`
Expected: FAIL — `TESTING.md` and `docs/escapes.md` do not exist.

- [ ] **Step 3: Wire it in** — the `package.json` and `scripts/tsconfig.json` changes above.

Run: `npm run check`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add scripts/test/docs.test.ts scripts/tsconfig.json package.json
git commit -m "Test that TESTING.md and the escape log stay true to the repo"
```

(Message gets the session line from Global Constraints.)

### Task 2: `docs/escapes.md`, seeded

**Files:**
- Create: `docs/escapes.md`

- [ ] **Step 1: Write `docs/escapes.md`**: one paragraph (what goes here — every bug found by hand or by L6/L7, added with its fix; escapes per class per month measure the strategy; rows before 2026-10-25 are seeded from commit messages, where "unstated" means the message does not say who found it), then the table. Date is each commit's `git show -s --format=%ad --date=short`; Test `—` for seeded rows. Rows, oldest first:

| Commit | Platform | Class | Found by | Should have caught |
|---|---|---|---|---|
| 332ff3a | firefox | B2 | unstated | L5 |
| f0b3b89 | firefox | B2 | unstated | L5 |
| b3003b1 | web | B3 | unstated | L1 |
| 4546a46 | ios | B1 | unstated | L3 |
| 628cbf9 | ios | B1 | unstated | L3 |
| 73ba916 | ios | B3 | unstated | L1 |
| 0f64f98 | ios | B3 | unstated | L6 |
| c4c5871 | ios | B3 | unstated | L6 |
| bdcf43e | ios | B3 | unstated | L1 |
| f3687d9 | ios | B3 | unstated | L1 |
| ae9ad29 | mac | B3 | unstated | L1 |
| 5d78bca | mac | B8 | unstated | L7 |
| 1ba97a6 | mac | B8 | unstated | L7 |
| 5c41379 | mac | B8 | unstated | L7 |
| 758a839 | web | B5 | unstated | L1 |
| fa2e532 | web | B5 | unstated | L3 |
| cd9d942 | ios | B5 | unstated | L7 |
| 169b077 | web | B4 | unstated | L4 |
| c54a5e4 | web | B4 | unstated | L3 |
| f6215a6 | web | B4 | unstated | L1 |
| 6475073 | web | B4 | unstated | L6 |
| 888d73a | web | B4 | unstated | L4 |
| dbada5d | web | B4 | unstated | L4 |
| c14e5a8 | web | B3 | unstated | L3 |
| fb49fff | web | B3 | unstated | L3 |
| c087059 | web | B2 | unstated | L3 |
| 036aa93 | web | B3 | unstated | L3 |
| 08a38da | web | B8 | unstated | L3 |
| 6bfa998 | mac | B5 | unstated | L1 |
| 830a708 | ios | B3 | unstated | L1 |
| 424d4ca | android | B3 | unstated | L3 |
| 8375434 | web | B4 | unstated | L4 |
| 90d22f2 | android | B3 | unstated | L1 |
| 6dfbafd | web | B4 | unstated | L4 |
| 8f23365 | mac | B1 | unstated | L3 |
| a3ddf48 | web | B1 | unstated | L3 |
| 6cc419a | android | B2 | unstated | L5 |
| d0b2795 | chromium | B2 | platform rows | L5 |
| c160eb8 | firefox | B2 | platform rows | L6 |
| 441d88d | web | B4 | unstated | L3 |
| 1dd075e | ios | B8 | unstated | L7 |
| 665b03d | firefox | B3 | soak | L1 |
| ebc0280 | firefox | B3 | soak | L1 |
| 025afc5 | web | B7 | hand | L8 |
| f942f51 | ios | B5 | iOS chaos | L7 |

Last row, the open bug: `2026-10-25 | ios | B1 | hand | L3 | pending | —` — Home Screen app, double tap at 25 % zoom zooms to 100 % with the caret off screen until the first key. Put that description in a footnote line under the table, since the table has no column for it.

- [ ] **Step 2: Run the docs test**

Run: `node --test scripts/test/docs.test.ts`
Expected: the escape test PASSES; the three `TESTING.md` tests still FAIL.

- [ ] **Step 3: Commit**

```bash
git add docs/escapes.md
git commit -m "Log the bugs that reached a person, seeded from the history by class and by the level that should have caught them, with the iOS new card's caret still open"
```

### Task 3: `TESTING.md`

**Files:**
- Create: `TESTING.md`
- Modify: `README.md` (`## Develop`: one line pointing to `TESTING.md` for how the tests are organised)

**Interfaces:**
- Consumes: the matrix format from Task 1.

- [ ] **Step 1: Write `TESTING.md`** with these sections, drawn from the spec, short:
  1. Why: one paragraph (bugs reach the owner first; each class has an owner level that is proven to fail on it).
  2. `## Bug classes`: the spec's B1–B8 table.
  3. `## Levels`: the spec's L1–L8 table (what exists, when it runs, which classes it owns), plus `Hand`.
  4. `## Two jobs`: guard on push, discovery nightly; both held to a flake budget; today's push retry stays until budgets are measured.
  5. `## Matrix`: the table below, then one line: a cell is owned only when it names a plant; `claimed` means a level has tests for the class but nothing proves they fail on it.
  6. `## When a bug escapes`: the three-part loop from the spec, pointing at `docs/escapes.md`.
  7. `## Adding a plant`: `planted("name")` in `web/sync/plant.ts` / `BreezyKit/Sources/BreezyKit/Plant.swift`, a test at the level that must fail with it (as `scripts/fuzz/test/plant.test.ts`), and the name in its matrix cell.
  8. Pointers: `docs/superpowers/specs/2026-10-11-breezy-testability-design.md`, `docs/platform-expectations.md`, `docs/quality-goals.md`, the spec.

The matrix today:

| Class | L1 | L2 | L3 | L4 | L5 | L6 | L7 | L8 |
|---|---|---|---|---|---|---|---|---|
| B1 | — | — | — | — | — | — | — | — |
| B2 | — | — | — | — | claimed | claimed | — | — |
| B3 | claimed | claimed | claimed | — | — | claimed | claimed | — |
| B4 | claimed | — | claimed | plant: pushed-skip, merge-local, order-all | — | claimed | — | — |
| B5 | claimed | — | — | — | — | claimed | claimed | — |
| B6 | — | — | — | — | — | — | claimed | — |
| B7 | — | — | — | — | — | — | — | claimed |
| B8 | — | — | — | — | — | — | claimed | — |

(B1 is empty on purpose: the cases tap where the board should keep a card in sight but never assert it.)

- [ ] **Step 2: Run the docs test**

Run: `node --test scripts/test/docs.test.ts`
Expected: all four tests PASS.

- [ ] **Step 3: Commit**

```bash
git add TESTING.md README.md
git commit -m "Say how Breezy's tests are organised: classes of bug from its history, the levels that own them, and today's matrix, where only the fuzzer proves it fails on its class"
```

### Task 4: The rule and the iPhone

**Files:**
- Modify: `CLAUDE.md` (one bullet)
- Modify: `docs/quality-goals.md` (opening paragraph)

- [ ] **Step 1: Add to `CLAUDE.md`**, as a bullet in its voice: a bug found by hand or by a nightly or soak run is fixed with a test at the lowest level that shows it, the fake taught when it was wrong, and a row in `docs/escapes.md`; `TESTING.md` says which level owns which class.

- [ ] **Step 2: Change `docs/quality-goals.md`'s first sentence** to name three platforms: me on the Mac and in the web app from an iPhone's Home Screen, my partner in the web app on a mid-range Android phone. Leave the scenarios' measures as they are.

- [ ] **Step 3: Run everything `npm test` runs, and the type check**

Run: `npm run check && npm test`
Expected: no type errors; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/quality-goals.md
git commit -m "Fix every escaped bug with a test, a taught fake and a line in the escape log, and name the iPhone's Home Screen app among the platforms Breezy is for"
```
