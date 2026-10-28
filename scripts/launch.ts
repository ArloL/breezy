#!/usr/bin/env node
// Quality goal 2c: from a launch to a drawn board in 1.5 s, as on a mid-range phone. Chromium at a phone's size with
// its CPU slowed 4×, the site in its service worker's cache as on a Home Screen, and scripts/make-stress-board.py's 500
// cards in the device's storage. The tap that opens the board is the person's, not the app's, and is not counted.
// In turns with a reference, so that what slows the runner for a while slows both alike: the site built in --ref, or
// this one without BREEZY_PLANT, or with --ref-without-recorder this one recording nothing (web/flight.ts), for what
// recording costs. Fails above 1.5 s, or as gate.ts finds this one worse than the reference.
//   node scripts/launch.ts [--runs 10] [--slowdown 4] [--ref DIR | --ref-without-recorder]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright-core";
import { buildSite, serveStatic } from "../scenarios/browser.ts";

const { values: opt } = parseArgs({ options: { runs: { type: "string", default: "10" }, slowdown: { type: "string", default: "4" }, ref: { type: "string" }, "ref-without-recorder": { type: "boolean" } } });
const RUNS = Number(opt.runs), GOAL = 1500;
const root = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "breezy-launch-"));
execFileSync("python3", [join(root, "scripts/make-stress-board.py"), join(tmp, "stress.breezy")]);
const board = JSON.parse(readFileSync(join(tmp, "stress.breezy"), "utf8"));

type At = { list?: number; board?: number };
const at = (page: Page) => page.evaluate(() => (window as unknown as { launchAt: At }).launchAt);

/** The site in `dir` on `port`, its board stored and its cache filled, ready to launch again and again. */
async function launcher(browser: Browser, dir: string, port: number, plant?: string, recording = true) {
  const server = serveStatic(dir, port);
  const context = await browser.newContext({ viewport: { width: 411, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2.6 });
  // a past fault put back, as in scripts/plants.ts
  if (plant) await context.addInitScript((name) => (globalThis as { __breezyPlant?: string }).__breezyPlant = name, plant);
  if (!recording) await context.addInitScript(() => (globalThis as { __breezyNoFlight?: boolean }).__breezyNoFlight = true);
  // when the board list and then the board were first drawn, on the page's own clock
  await context.addInitScript(() => {
    const at: At = {}, seen = new Set<keyof At>();
    (window as unknown as { launchAt: At }).launchAt = at;
    // the first frame after each shows; a card of the board's, not the one .measure always holds
    const drawn = (k: keyof At) => !seen.has(k) && seen.add(k) && requestAnimationFrame(() => at[k] ??= performance.now());
    new MutationObserver(() => {
      if (document.querySelector(".boards-list li[data-board] .open")) drawn("list");
      if (document.body?.dataset.screen === "board" && document.querySelector(".cards > [data-id]")) drawn("board");
    }).observe(document, { subtree: true, childList: true, attributes: true });
  });
  const page = await context.newPage();
  const url = `http://localhost:${port}/`;
  // the board stored as the app stores it, from a page of the site the app does not run in
  await page.goto(`${url}blank`);
  await page.evaluate(async (b) => {
    // the site's own modules, which this script's compiler does not see
    const site = (path: string) => import(path);
    const { storage } = await site("/sync/idb.js");
    const { Store } = await site("/sync/store.js");
    const store = new Store();
    store.createBoard("Stress", b);
    await storage.save("local", store.state);
  }, board);
  // a first launch fills the service worker's cache
  await page.goto(url);
  await page.waitForSelector(".boards-list li[data-board] .open");
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: Number(opt.slowdown) });
  const results: Record<string, number[]> = { "launch: board list": [], "launch: board after the tap": [], "launch: to a drawn board": [] };
  return {
    results,
    async launch() {
      // the board left first, as the system ends an app, so that its unload counts in no launch
      await page.goto("about:blank");
      await page.goto(url);
      await page.waitForFunction(() => (window as unknown as { launchAt: At }).launchAt.list);
      const tapped = await page.evaluate(() => {
        const t = performance.now();
        document.querySelector<HTMLElement>(".boards-list li[data-board] .open")!.click();
        return t;
      });
      await page.waitForFunction(() => (window as unknown as { launchAt: At }).launchAt.board, null, { timeout: 30_000 });
      const { list, board } = await at(page) as Required<At>;
      results["launch: board list"]!.push(list);
      results["launch: board after the tap"]!.push(board - tapped);
      results["launch: to a drawn board"]!.push(list + board - tapped);
      return `the board list after ${Math.round(list)} ms, the board ${Math.round(board - tapped)} ms after the tap`;
    },
    close: () => server.close(),
  };
}

const here = join(root, "build", "web-launch");
buildSite(here);
const browser = await chromium.launch();
const run = await launcher(browser, here, 58571, process.env.BREEZY_PLANT);
const ref = await launcher(browser, opt.ref ?? here, 58572, undefined, !opt["ref-without-recorder"]);
for (let r = 0; r < RUNS; r++) console.log(`run ${r + 1}: ${await run.launch()}; the reference's ${await ref.launch()}`);
await browser.close();
run.close();
ref.close();

const total = run.results["launch: to a drawn board"]!, mean = total.reduce((s, x) => s + x, 0) / total.length;
console.log(`launch to a drawn board, the tap not counted: ${Math.round(mean)} ms on average, at most ${GOAL} ms wanted`);
writeFileSync(join(tmp, "run.json"), JSON.stringify({ opt, results: run.results }));
writeFileSync(join(tmp, "ref.json"), JSON.stringify({ opt, results: ref.results }));
const gate = spawnSync("node", [join(root, "scripts/gate.ts"), join(tmp, "run.json"), join(tmp, "ref.json")], { encoding: "utf8" });
console.log(gate.stdout.trimEnd());
console.log(JSON.stringify({ opt, results: run.results }));
process.exit(mean > GOAL || gate.status !== 0 ? 1 : 0);
