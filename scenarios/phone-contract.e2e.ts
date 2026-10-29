// The hub's phones (web/test/fakes.ts) held to the phones they stand for: PHONE and MINI to the iPhone 17's and the iPhone
// 13 mini's Home Screen app in the iOS Simulator, SAFARI and SAFARI_MINI to their Safari tab, ANDROID to Chrome on the
// Android emulator. Where the board shows in the page at rest and while a card is edited, above the keyboard, and how
// long the keyboard takes to come. Run with IPHONE="iPhone 13 mini" or none node scripts/ios.ts --home first, or without
// --home as PHONE_KIND=ios-safari, or as PHONE_KIND=android after node scripts/android.ts:
//   node --test --test-force-exit scenarios/phone-contract.e2e.ts
import { test } from "node:test";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import { ANDROID, MINI, PHONE, SAFARI, SAFARI_MINI } from "../web/test/fakes.ts";
import { BrowserDevice, RealWorld } from "./browser.ts";
import { iosUnfit, IosDevice } from "./ios.ts";
import { exitsAfter } from "./exit.ts";

// the Home Screen app, as the owner uses it, unless asked for a tab or Android
const kind = process.env.PHONE_KIND === "ios-safari" || process.env.PHONE_KIND === "android" ? process.env.PHONE_KIND : "ios-home";
/** How far the fake may stand from the phone: a line of text, and a keyboard's animation, which the emulator's varies
 * by hundreds of ms. */
const PT = 24, MS = kind === "android" ? 400 : 250;

test(`the hub's phone shows the board, and brings the keyboard, as the phone does (${kind})`, { skip: kind !== "android" && await iosUnfit(), timeout: 300_000 }, async () => {
  const w = new RealWorld();
  try {
    await w.start([kind]);
    const d = w.devices[0] as IosDevice | BrowserDevice;
    const page = d.page as unknown as { evaluate<R, A>(f: (a: A) => R | Promise<R>, arg?: A): Promise<R>; screenshot(): Promise<Buffer> };
    const rest = await page.evaluate(() => {
      const r = (q: string) => document.querySelector(q)?.getBoundingClientRect();
      return { top: r("#top")?.bottom ?? 0, bottom: r("#bottom")?.top ?? innerHeight, w: innerWidth, h: innerHeight };
    });
    // when the editor takes focus, and each time the visual viewport changes, on the page's clock
    await page.evaluate(() => {
      const t: number[] = [];
      (window as { keyboard?: number[] }).keyboard = t;
      addEventListener("focusin", () => t.splice(0, t.length, performance.now()));
      visualViewport!.addEventListener("resize", () => t.push(performance.now()));
    });
    // the iPhone's by its width
    const fakeOf = kind === "android" ? ANDROID : (kind === "ios-safari" ? [SAFARI, SAFARI_MINI] : [PHONE, MINI]).find((s) => s.w === rest.w);
    if (!fakeOf) throw new Error(`the hub has no phone ${rest.w} pt wide`);
    const size = await d.size();
    // a board just opened in the Home Screen app takes no touch for a moment, and IosDevice fails one the page never hears
    await d.wait(1500);
    await d.tap(await d.world({ x: size.w / 2, y: size.h * 0.6 }));
    await d.wait(800);
    await d.doubleTap(await d.world({ x: size.w / 2, y: size.h * 0.3 }));
    await d.until("an editor to open", async () => !!(await d.editor()), 10_000).catch(async (e) => {
      writeFileSync("build/phone-contract.png", await page.screenshot());
      throw e;
    });
    await d.still("the keyboard to come and the board to stand still");
    const s = (await d.sight())!, times = await page.evaluate(() => (window as { keyboard?: number[] }).keyboard ?? []);
    // in the visual viewport, as a case's taps aim: iOS scrolls the page under a keyboard
    const at = -(s.screen?.y ?? 0), top = s.visible.y + at, bottom = s.visible.y + s.visible.h + at;
    const fake = { h: fakeOf.h, top: fakeOf.keyboardTop ?? fakeOf.top, bottom: fakeOf.h - fakeOf.keyboard - 44, ms: fakeOf.keyboardMs, restTop: fakeOf.top, restBottom: fakeOf.bottom };
    const real = { h: rest.h, top: Math.round(top), bottom: Math.round(bottom), ms: times.length > 1 ? Math.round(times.at(-1)! - times[0]!) : null,
      restTop: Math.round(rest.top), restBottom: Math.round(rest.bottom) };
    const say = `the ${kind} ${JSON.stringify(real)} on ${rest.w}×${rest.h}, the hub's ${JSON.stringify(fake)} (${s.how})`;
    assert.ok(Math.abs(real.h - fake.h) <= PT, say);
    assert.ok(Math.abs(real.restTop - fake.restTop) <= PT && Math.abs(real.restBottom - fake.restBottom) <= PT, say);
    assert.ok(Math.abs(real.top - fake.top) <= PT, say);
    assert.ok(Math.abs(real.bottom - fake.bottom) <= PT, say);
    assert.ok(real.ms !== null && Math.abs(real.ms - fake.ms) <= MS, say);
  } finally {
    await w.stop();
  }
});

// last, so that the file's own cleanup runs before its 10 s begin
exitsAfter();
