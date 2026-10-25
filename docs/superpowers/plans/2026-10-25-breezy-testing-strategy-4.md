# Testing strategy, step 4: plants per level — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Every matrix cell that names a plant is proven by a run that fails with that plant on, and a job runs all of them.

**Architecture:** `scripts/plants.ts` holds the table of plants — name, class, level, the command that runs that level — and runs each command with `BREEZY_PLANT` (and `SCENARIO_PLANT` for real devices) set, requiring it to fail. `planted()` reads `BREEZY_PLANT` from the environment when no global is set, so unit tests and hub cases take a plant without code of their own. The docs test requires each matrix plant to be in the table at that class and level. A weekly workflow runs the cheap levels; the iOS workflow runs the L6 plant.

**Spec:** `docs/superpowers/specs/2026-10-25-breezy-testing-strategy-design.md` ("Each level proven")

## Global Constraints

- A plant is a past bug, put back by name where it was fixed; never a bug invented to be caught.
- A plant must make its level fail and the level must pass without it; the plain suite proves the second.
- No new dependencies.

## Plants

| Plant | Class | Where | Past fix | Levels |
|---|---|---|---|---|
| reveal-current | B1 | `web/camera.ts` `Camera.goal` | the iOS new card | L3, L6 |
| ime-keys | B2 | `web/ime.ts` `composingKey` | `d0b2795` | L1, L5 |
| lost-release | B3 | `web/mouse.ts` `Mouse.down` | `b3003b1` | L1 |
| merge-local | B4 | `web/sync/merge.ts`, `Merge.swift` | `8014771` | L1, L4 |
| pushed-skip | B4 | `web/sync/engine.ts`, `Sync.swift` | the fuzzer's | L4 |
| half-deploy | B5 | `web/sw.ts` `download` | the hash check | L1 |

## Tasks

### Task 1: `planted()` from the environment, and the plants
- [ ] Test (`web/test/plant.test.ts`): with `globalThis.__breezyPlant` unset and `process.env.BREEZY_PLANT = "x"`, `planted("x")` is true; a set global wins.
- [ ] Implement in `web/sync/plant.ts`; `World.start`'s plant defaults to `BREEZY_PLANT`.
- [ ] Put `ime-keys`, `lost-release`, `half-deploy` where the table says; `sw.ts` cannot import, so it reads the same two places itself.
- [ ] Run each level's command with each plant by hand and see it fail; `npm test` passes without.

### Task 2: `scripts/plants.ts` and the docs test
- [ ] `export const PLANTS: { plant: string; class: string; level: string; command: string[]; env?: Record<string, string> }[]`; run with `node scripts/plants.ts [--level L1,L3]`: each command with the plant set must exit non-zero; prints plant, level, verdict; exits 1 if any survives.
- [ ] Docs test: every plant in a matrix cell is in `PLANTS` with that class and level.

### Task 3: The jobs and the record
- [ ] `.github/workflows/plants.yaml`: weekly and on dispatch, macOS, levels L1 L3 L4 L5.
- [ ] `ios.yaml`: after the scenarios, `node scripts/plants.ts --level L6`.
- [ ] `TESTING.md`: matrix cells as the table; "Adding a plant" points at `scripts/plants.ts`.
