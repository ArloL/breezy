// The agent that reads an iPhone's page for the scenarios, where safaridriver cannot reach: a tab here, and the Home
// Screen's app. Checked in Chromium posing as an iPhone.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import { Agent } from "../agent.ts";
import { serveStatic } from "../browser.ts";

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 27_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0 Mobile/15E148 Safari/604.1";
let browser: Browser, server: ReturnType<typeof serveStatic>, url = "";
const agent = new Agent();

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "breezy-agent-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>one</title><body>");
  writeFileSync(join(dir, "two.html"), "<!doctype html><title>two</title><body>");
  server = serveStatic(dir, 0, agent);
  await once(server, "listening");
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  browser = await chromium.launch();
});

after(async () => {
  await browser?.close();
  server?.close();
  agent.stop();
});

test("the agent runs a function in an iPhone's page and hands back its value", async () => {
  const page = await browser.newPage({ userAgent: IPHONE });
  await page.goto(url);
  assert.equal(await agent.page.evaluate((x: number) => `${document.title} ${x + 1}`, 1), "one 2");
  await page.close();
});

test("a function that throws rejects with its error", async () => {
  const page = await browser.newPage({ userAgent: IPHONE });
  await page.goto(url);
  await assert.rejects(agent.page.evaluate(() => { throw new Error("boom"); }), /boom/);
  await page.close();
});

test("goto loads another page, which the agent follows", async () => {
  const page = await browser.newPage({ userAgent: IPHONE });
  await page.goto(url);
  await agent.page.evaluate(() => document.title);
  await agent.page.goto(`${url}two.html`);
  assert.equal(await agent.page.evaluate(() => document.title), "two");
  await page.close();
});

test("a page served to a desktop browser gets no agent", async () => {
  const page = await browser.newPage();
  const res = await page.goto(url);
  assert.doesNotMatch(await res!.text(), /agent/);
  await page.close();
});
