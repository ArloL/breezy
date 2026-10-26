// The hub's phone (web/test/fakes.ts's PHONE) held to the iPhone it stands for, in the iOS Simulator: where the board
// shows while a card is edited, above the keyboard, and how long the keyboard takes to come. Run with node scripts/ios.ts
// first, with --home, or as PHONE_KIND=ios-safari for a tab, which differs and only reports:
//   node --test --test-force-exit scenarios/phone-contract.e2e.ts
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { PHONE } from "../web/test/fakes.ts";
import { RealWorld } from "./browser.ts";
import { iosUnfit, type IosDevice } from "./ios.ts";

// the Home Screen app, as the owner uses it and the hub's phone stands for; a tab only reports what it measured
const kind = process.env.PHONE_KIND === "ios-safari" ? "ios-safari" : "ios-home";
/** How far the fake may stand from the iPhone: a line of text, and a keyboard's animation. */
const PT = 24, MS = 250;

test(`the hub's phone shows the board, and brings the keyboard, as the iPhone does (${kind})`, { skip: await iosUnfit(), timeout: 180_000 }, async () => {
  const w = new RealWorld();
  try {
    await w.start([kind]);
    const d = w.devices[0] as IosDevice;
    // when the editor takes focus, and each time the visual viewport changes, on the page's clock
    await d.page.evaluate(() => {
      const t: number[] = [];
      (window as { keyboard?: number[] }).keyboard = t;
      addEventListener("focusin", () => t.splice(0, t.length, performance.now()));
      visualViewport!.addEventListener("resize", () => t.push(performance.now()));
    });
    const size = await d.size();
    // a board just opened in the Home Screen app takes no touch for a moment
    await d.tap(await d.world({ x: size.w / 2, y: size.h * 0.6 }));
    await d.wait(800);
    await d.doubleTap(await d.world({ x: size.w / 2, y: size.h * 0.3 }));
    await d.until("an editor to open", async () => !!(await d.editor()), 10_000).catch(async (e) => {
      writeFileSync("build/phone-contract.png", await d.page.screenshot());
      throw e;
    });
    await d.still("the keyboard to come and the board to stand still");
    const s = (await d.sight())!, times = await d.page.evaluate(() => (window as { keyboard?: number[] }).keyboard ?? []);
    // on the screen: from where the screen starts in the page, which iOS moves as it scrolls the page under a keyboard
    const dy = d.offset.y - (s.screen?.y ?? 0), top = s.visible.y + dy, bottom = s.visible.y + s.visible.h + dy;
    const fake = { top: PHONE.keyboardTop ?? PHONE.top, bottom: PHONE.h - PHONE.keyboard - 44, ms: PHONE.keyboardMs };
    const real = { top: Math.round(top), bottom: Math.round(bottom), ms: times.length > 1 ? Math.round(times.at(-1)! - times[0]!) : null };
    const say = `the iPhone ${JSON.stringify(real)}, the hub's phone ${JSON.stringify(fake)} (${s.how})`;
    if (kind === "ios-safari") return void console.log(say);
    assert.ok(Math.abs(real.top - fake.top) <= PT, say);
    assert.ok(Math.abs(real.bottom - fake.bottom) <= PT, say);
    assert.ok(real.ms !== null && Math.abs(real.ms - fake.ms) <= MS, say);
  } finally {
    await w.stop();
  }
});
