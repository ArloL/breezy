// Scenarios written once for any kind of device: on the hub's fakes (cases.test.ts) and on real devices
// (browsers.e2e.ts). Each acts on the first device and looks at what the second shows.
import assert from "node:assert/strict";
import { centre, item, type Box, type Device, type Editor, type Frame } from "./device.ts";
import { LANE_H, LANE_W } from "../web/rules.ts";
import type { Point } from "../web/types.ts";

export interface Stage {
  devices: Device[];
  /** Until what one device did shows on the others. */
  settle(): Promise<void>;
}

export interface Case {
  name: string;
  /** What the first device's input must be. */
  input: "mouse" | "touch";
  /** Whether the first device must edit text, which the hub's fakes cannot yet. */
  edits?: boolean;
  /** Whether the first device must draw its text for the case to see, which the hub's fakes do not. */
  draws?: boolean;
  /** Whether the first device must be kept busy, which the hub's fakes and the Mac cannot. */
  busy?: boolean;
  /** Whether the first device must go offline and launch again, which the hub's fakes cannot. */
  offline?: boolean;
  /** Why the iPhone in the iOS Simulator cannot act in it, if it cannot. */
  notOnIphone?: string;
  /** How many fingers the first device must put down at once, if more than one: the iOS Simulator takes one. */
  fingers?: number;
  /** How long a run may take on real devices, if longer than most. */
  ms?: number;
  /** The kinds of real device that may act, if not all. */
  acts?: string[];
  /** The kinds of real device that may watch, if not all. */
  watches?: string[];
  run(s: Stage): Promise<void>;
}

/** A lane in the middle of the first device's screen and a card beside it, made there, and seen by the others. On a
 * phone, the lane at the top left and the card below it. */
async function laneAndCard({ devices: [a], settle }: Stage) {
  const narrow = (await a!.size()).w < 900;
  const at = await a!.world(narrow ? { x: 24, y: 96 } : { x: 450, y: 440 });
  const lane = await a!.addLane(narrow ? at.x + LANE_W / 2 : at.x, narrow ? at.y + LANE_H / 2 : at.y);
  const l = item(await a!.scene(), lane);
  const card = narrow ? await a!.addCard(l.x + l.w / 2, l.y + l.h + 72) : await a!.addCard(l.x + l.w + 200, l.y + 200);
  await settle();
  return { lane, card };
}

/** Where a finger presses card `c`: by its left end, as the + button a phone shows at the bottom of the screen covers
 * the middle of a card laneAndCard puts low there, the more so in Firefox on Android, which leaves the board less height. */
const press = (c: { x: number; y: number; h: number }): Point => ({ x: c.x + 24, y: c.y + c.h / 2 });

/** Until `test` holds, checked every 250 ms on `d`'s clock for at most `ms`. */
async function eventually(d: Device, ms: number, test: () => Promise<boolean>) {
  for (let t = 0; t < ms; t += 250) {
    if (await test()) return true;
    await d.wait(250);
  }
  return test();
}

/** Where `id` is drawn relative to `lane` on device `d`. */
async function within(d: Device, lane: string, id: string) {
  const s = await d.scene();
  const l = item(s, lane), c = item(s, id);
  return { x: c.x - l.x, y: c.y - l.y };
}

/** Where the editor's text and caret should be. */
interface Want {
  text: string;
  at: number;
}

const mid = (b: Box) => b.y + b.h / 2;

/**
 * Whether `e` draws the text and caret of `want`: the title, up to the first newline, semibold and the rest regular; the
 * caret against the character before or after it, at a soft wrap either; between newlines, at the line's start as many
 * lines down as there are newlines; and inside the card and what the screen shows.
 */
function drawn(e: Editor | null, want: Want, card: Box) {
  assert.ok(e, "nothing is being edited");
  assert.deepEqual({ text: e.text, at: e.at }, want, "the text and caret");
  const title = want.text.includes("\n") ? want.text.indexOf("\n") : want.text.length;
  for (let i = 0; i < want.text.length; i++) {
    if (want.text[i] === "\n") continue;
    const w = e.weights[i]!, ok = i < title ? w >= 600 : w <= 500;
    assert.ok(ok, `${JSON.stringify(want.text[i])} at ${i}, in the ${i < title ? "title" : "rest"}, weighs ${w}`);
  }
  const c = e.caret;
  assert.ok(c, "no caret is drawn");
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  const line = (b: Box) => Math.abs(mid(c) - mid(b)) < e.line / 2;
  const before = e.chars[want.at - 1], after = e.chars[want.at];
  if (before || after) {
    const ok = !!before && line(before) && near(c.x, before.x + before.w) || !!after && line(after) && near(c.x, after.x);
    assert.ok(ok, `the caret ${JSON.stringify(c)} is not beside ${JSON.stringify(before)} before it or ${JSON.stringify(after)} after it`);
  } else {
    let k = want.at - 1;
    while (k >= 0 && !e.chars[k]) k--;
    const down = want.text.slice(k + 1, want.at).split("\n").length - 1;
    const y = k >= 0 ? mid(e.chars[k]!) + down * e.line : e.origin.y + (down + 0.5) * e.line;
    assert.ok(near(c.x, e.origin.x) && Math.abs(mid(c) - y) < e.line / 2,
      `the caret ${JSON.stringify(c)} is not at the start of the line ${down} below ${k >= 0 ? `${JSON.stringify(e.chars[k])}` : "the top"}, at x ${e.origin.x}, mid y ${y}`);
  }
  const inside = (b: Box, r: Box) => b.x >= r.x - 1 && b.y >= r.y - 1 && b.x + b.w <= r.x + r.w + 1 && b.y + b.h <= r.y + r.h + 1;
  assert.ok(inside(c, card), `the caret ${JSON.stringify(c)} is outside the card ${JSON.stringify(card)}`);
  assert.ok(inside(c, e.view), `the caret ${JSON.stringify(c)} is out of sight of ${JSON.stringify(e.view)}`);
}

/** Card `id` on `d`'s screen. */
async function onScreen(d: Device, id: string): Promise<Box> {
  const s = await d.scene();
  const c = item(s, id), z = s.camera.zoom;
  return { x: c.x * z + s.camera.x, y: c.y * z + s.camera.y, w: c.w * z, h: c.h * z };
}

/** Until `d`'s editor draws `want`, as a person waits to see a key's effect: a busy phone shows it a moment later. */
async function shows(d: Device, card: string, want: Want, after: string) {
  for (let t = 0; ; t += 100) {
    try {
      return drawn(await d.editor(), want, await onScreen(d, card));
    } catch (e) {
      if (t >= 3000) throw new Error(`after ${after}: ${(e as Error).message}`, { cause: e });
    }
    await d.wait(100);
  }
}

/**
 * Edits card `id` at the end of its text, one step at a time: text typed, "\n" Return or "\b" ⌫; after each, the
 * editor draws the text and caret it should. Returns what it should hold.
 */
async function edit(d: Device, id: string, want: Want, steps: string[]): Promise<Want> {
  for (const [i, step] of steps.entries()) {
    if (step === "\b") {
      await d.key("Backspace");
      if (want.at) want = { text: want.text.slice(0, want.at - 1) + want.text.slice(want.at), at: want.at - 1 };
    } else {
      if (step === "\n") await d.key("Enter");
      else await d.type(step);
      want = { text: want.text.slice(0, want.at) + step + want.text.slice(want.at), at: want.at + step.length };
    }
    await shows(d, id, want, JSON.stringify(steps.slice(0, i + 1).join("")));
  }
  return want;
}

/** A card made where nothing is, at screen point `at`, as a person makes one with `input`, and its id once it is being edited. */
async function newCard(d: Device, input: "mouse" | "touch", at?: Point) {
  const narrow = (await d.size()).w < 900;
  const p = await d.world(at ?? (narrow ? { x: 40, y: 200 } : { x: 400, y: 200 }));
  const had = new Set((await d.scene()).cards.map((c) => c.id));
  await (input === "touch" ? d.doubleTap(p) : d.doubleClick(p));
  let id = "";
  await d.until("a new card", async () => !!(id = (await d.scene()).cards.find((c) => !had.has(c.id))?.id ?? ""));
  await shows(d, id, { text: "", at: 0 }, "the double " + (input === "touch" ? "tap" : "click"));
  return id;
}

/** Ends the edit as a person does: Esc, or on a phone a tap on the board, at world point `at` or just above the card,
 * kept in sight of the keyboard; and until the front at rest is semibold up to the first newline. */
async function endEdit(d: Device, id: string, input: "mouse" | "touch", at?: Point) {
  if (input === "touch") {
    const c = item(await d.scene(), id);
    await d.tap(at ?? { x: c.x + c.w / 2, y: c.y - 40 });
  } else {
    await d.key("Escape");
  }
  await d.until("the edit to end", async () => !(await d.editor()));
  // as a person waits to see the keyboard go: Android took the first tap of a double tap 130 ms after an edit ended
  if (input === "touch") await d.still("the keyboard to go and the board to stand still");
  // read until the front is drawn as the text at rest: a browser trims it, and removes a card left blank, a frame later
  for (let t = 0; ; t += 100) {
    const card = (await d.scene()).cards.find((c) => c.id === id);
    if (card?.text && card.text !== card.text.trimEnd() && t < 2000) {
      await d.wait(100);
      continue;
    }
    const weights = card?.text ? await d.weights(id) : null;
    if (!card?.text || !weights) return;
    const title = card.text.includes("\n") ? card.text.indexOf("\n") : card.text.length;
    const want = [...card.text].filter((ch) => ch !== "\n").map((_, i) => i < title ? 600 : 400);
    if (t >= 2000 || JSON.stringify(weights) === JSON.stringify(want)) return assert.deepEqual(weights, want, `the weights at rest of ${JSON.stringify(card.text)}`);
    await d.wait(100);
  }
}

/** Typing at the end of a title and the lines below it, Return, ⌫ back across them, and again. */
const lines = (input: "mouse" | "touch"): Case => ({
  name: `a card's title and lines typed, deleted and typed again ${input === "touch" ? "on a phone " : ""}show the caret after the last key, the title semibold`,
  input,
  edits: true,
  draws: true,
  async run(s) {
    const [a, b] = s.devices as [Device, Device];
    const id = await newCard(a, input);
    let want = await edit(a, id, { text: "", at: 0 }, [
      "Groceries", "\n", "milk", "\n", "\n", "\b", "\b", "\b", "\b", "\b", "\b", "\b", "\n", "eggs",
      ...Array<string>(14).fill("\b"), "Shopping",
    ]);
    await endEdit(a, id, input);
    const c = centre(item(await a.scene(), id));
    await (input === "touch" ? a.doubleTap(c) : a.doubleClick(c));
    await shows(a, id, { text: want.text, at: want.text.length }, "opening it again");
    want = await edit(a, id, { text: want.text, at: want.text.length }, ["\n", "bread", "\n", "\n", "butter"]);
    await endEdit(a, id, input);
    await s.settle();
    assert.equal(item(await b.scene(), id).text, want.text);
  },
});

/** Typing word by word into a title and a line below that both wrap, ⌫ back across the wraps and the newline, and on. */
const wrapping = (input: "mouse" | "touch"): Case => ({
  name: `a card's title and lines that wrap ${input === "touch" ? "on a phone " : ""}show the caret after the last key, the title semibold`,
  input,
  edits: true,
  draws: true,
  // docs/platform-expectations.md
  notOnIphone: "after the backspaces, iOS's keyboard replaces \"for the\" typed after them with \"for\", in any editable element",
  async run(s) {
    const [a, b] = s.devices as [Device, Device];
    const id = await newCard(a, input);
    /** Each word a step, after a space but the first: the caret is never after a space a line may end in. */
    const words = (t: string, after = false) => t.split(" ").map((w, i) => (i || after ? ` ${w}` : w));
    let want = await edit(a, id, { text: "", at: 0 }, [
      ...words("Ask the neighbours whether they could water the plants while we are away"), "\n",
      ...words("Fill the can from the rain barrel behind the shed and leave the key under the pot"),
    ]);
    // back across the last two wraps, the newline and into the title, one key at a time
    const back = want.text.length - want.text.indexOf("\n") + " are away".length;
    want = await edit(a, id, want, Array<string>(back).fill("\b"));
    want = await edit(a, id, want, [...words("are away for the summer", true), "\n", ...words("Water twice a week")]);
    await endEdit(a, id, input);
    await s.settle();
    assert.equal(item(await b.scene(), id).text, want.text);
  },
});

/** A title composed into a new card by an input method, as Samsung Keyboard composes a word until it ends. */
const composed = (input: "mouse" | "touch"): Case => ({
  name: `a title composed into a new card by an input method ${input === "touch" ? "on a phone " : ""}is semibold while it is composed`,
  input,
  edits: true,
  draws: true,
  // the browser whose input method DevTools drives: Android's keyboard commits a composition it did not start
  acts: ["chromium"],
  async run(s) {
    const [a, b] = s.devices as [Device, Device];
    const id = await newCard(a, input);
    const word = "Groceries";
    for (let i = 1; i <= word.length; i++) {
      await a.compose(word.slice(0, i));
      await shows(a, id, { text: word.slice(0, i), at: i }, `composing ${JSON.stringify(word.slice(0, i))}`);
    }
    await a.compose(null);
    await shows(a, id, { text: word, at: word.length }, "the word committed");
    await endEdit(a, id, input);
    await s.settle();
    assert.equal(item(await b.scene(), id).text, word);
  },
});

/** mulberry32: numbers in [0, 1) from `seed`, the same on every run. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** CHAOS_SEED replays a run; CHAOS_STEPS sets its length. */
const CHAOS_SEED = Number(process.env.CHAOS_SEED ?? Math.floor(Math.random() * 2 ** 31));
const CHAOS_STEPS = Number(process.env.CHAOS_STEPS ?? 120);

/**
 * Keys pressed at random into cards made, opened again and deleted at random, as a monkey would: text typed anywhere,
 * Return and ⌫ and ⌦ most often beside a newline, arrows, ⌘-arrows and a selection typed over. On a phone, what its
 * keyboard has, the caret moved by a tap on the text, and no deleting cards. After each key the editor draws the text
 * and caret it should, the title semibold; at rest, every card's text shows on the other device.
 */
const chaos = (input: "mouse" | "touch"): Case => ({
  name: `keys pressed at random into cards made, opened and deleted at random ${input === "touch" ? "on a phone " : ""}show the caret after each key, the title semibold`,
  input,
  edits: true,
  draws: true,
  ms: 60_000 + CHAOS_STEPS * (input === "touch" ? 3000 : 500),
  // Firefox has two caret positions at a soft wrap, so arrows move it fewer characters than pressed; WebKit loses the
  // editor's focus on some double-clicks that open it
  acts: ["mac", "chromium", "android"],
  async run(s) {
    const [a, b] = s.devices as [Device, Device];
    const rnd = random(CHAOS_SEED);
    /** The screen with no keyboard on it, and whether it is a phone's, where a keyboard comes up to edit. */
    const full = (await a.size()).h, phone = (await a.size()).w < 900;
    const keyboard = () => phone && a.until("the keyboard to come", async () => ((await a.editor())?.view.h ?? full) < full - 150);
    const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
    const tokens = ["Milk", "eggs", "a", "x", " ", "  ", "two words", "Ünïcödé", "42", ".", "a longer line that will surely wrap at the edge of the card"];
    /** What each card at rest should hold. */
    const kept = new Map<string, string>();
    const log: string[] = [];
    let id: string | null = null, want: Want = { text: "", at: 0 };
    /** Where a tap last put the caret on a phone. */
    let tapped: Box | null = null;

    /** Somewhere on screen with no card near, else null. */
    const room = async (): Promise<Point | null> => {
      await a.still("the board to stand still");
      const sc = await a.scene(), size = await a.size(), wide = 280 * sc.camera.zoom;
      const boxes = await Promise.all(sc.cards.map((c) => onScreen(a, c.id)));
      const spots: Point[] = [];
      for (let y = 140; y < size.h - 160; y += 250) for (let x = 40; x < size.w - wide; x += 300) spots.push({ x, y });
      const free = spots.filter((p) => boxes.every((r) => p.x < r.x - 60 || p.x > r.x + r.w + wide || p.y < r.y - 60 || p.y > r.y + r.h + 200));
      return free.length ? pick(free) : null;
    };
    /** A world point on card `c` that shows on screen, clear of the other cards and of a browser's bars, as a person would
     * aim; else null. */
    const aim = async (c: string): Promise<Point | null> => {
      await a.still("the board to stand still");
      const sc = await a.scene(), size = await a.size(), r = await onScreen(a, c);
      const others = await Promise.all(sc.cards.filter((x) => x.id !== c).map((x) => onScreen(a, x.id)));
      for (const fy of [0.5, 0.2, 0.8, 0.35, 0.65, 0.1, 0.9]) for (const fx of [0.5, 0.25, 0.75]) {
        const p = { x: r.x + r.w * fx, y: r.y + r.h * fy };
        const shows = p.x > 30 && p.y > 90 && p.x < size.w - 40 && p.y < size.h - 70;
        if (shows && others.every((o) => p.x < o.x - 4 || p.x > o.x + o.w + 4 || p.y < o.y - 4 || p.y > o.y + o.h + 4)) return a.world(p);
      }
      return null;
    };
    const step = async (what: string, act: () => Promise<void>, next: (w: Want) => Want | Promise<Want>) => {
      log.push(what);
      const was = want;
      await act();
      want = await next(want);
      await shows(a, id!, want, `${what} from ${JSON.stringify(was)}, step ${log.length}`);
    };
    const insert = (t: string) => (w: Want) => ({ text: w.text.slice(0, w.at) + t + w.text.slice(w.at), at: w.at + t.length });
    const moveTo = async (to: number) => {
      const n = to - want.at;
      for (let i = 0; i < Math.abs(n); i++) await a.key(n < 0 ? "ArrowLeft" : "ArrowRight");
    };
    /** The caret where the device put it, for moves whose end depends on how lines wrap. */
    const theirs = async (w: Want) => {
      const e = await a.editor();
      assert.ok(e, "nothing is being edited");
      assert.equal(e.text, w.text, "a move changed the text");
      return { text: w.text, at: e.at };
    };
    /** On a phone, a tap on the board where it shows clear of the cards, which ends the edit. */
    const clear = async (): Promise<Point | undefined> => {
      if (input === "mouse") return undefined;
      await keyboard();
      await a.still("the keyboard and the board to stand still");
      const e = await a.editor(), sc = await a.scene();
      assert.ok(e, "nothing is being edited");
      const boxes = await Promise.all(sc.cards.map((c) => onScreen(a, c.id)));
      for (let y = e.view.y + 120; y < e.view.y + e.view.h - 40; y += 40) for (let x = 30; x < e.view.w - 30; x += 40) {
        if (boxes.every((r) => x < r.x - 20 || x > r.x + r.w + 20 || y < r.y - 20 || y > r.y + r.h + 20)) return a.world({ x, y });
      }
      throw new Error("no board shows clear of the cards to tap");
    };
    const end = async () => {
      log.push(input === "touch" ? "tap the board" : "Esc");
      tapped = null;
      await endEdit(a, id!, input, await clear());
      const text = want.text.trimEnd();
      if (text) kept.set(id!, text);
      else {
        kept.delete(id!);
        await a.until("a card left blank to be removed", async () => !(await a.scene()).cards.some((c) => c.id === id));
      }
      id = null;
    };

    try {
      for (let n = 0; n < CHAOS_STEPS; n++) {
        if (!id) {
          const r = rnd(), spot = r < 0.5 || !kept.size ? await room() : null;
          if (spot) {
            log.push(`new card at ${spot.x},${spot.y}`);
            id = await newCard(a, input, spot);
            want = { text: "", at: 0 };
            if (input === "touch") await a.wait(600);
          } else if (r < 0.85 && kept.size) {
            const c = pick([...kept.keys()]), p = await aim(c);
            if (!p) continue;
            log.push(`open ${c}`);
            id = c;
            await (input === "touch" ? a.doubleTap(p) : a.doubleClick(p));
            want = { text: kept.get(c)!, at: kept.get(c)!.length };
            await shows(a, c, want, `opening ${c}, step ${log.length}`);
            // as a person waits to see it open: a tap just after a double tap is a triple tap, which selects the line
            if (input === "touch") await a.wait(600);
          } else if (kept.size && input === "mouse") {
            const c = pick([...kept.keys()]), p = await aim(c);
            if (!p) continue;
            log.push(`delete ${c}`);
            await a.click(p);
            await a.key("Backspace");
            kept.delete(c);
            await a.until(`${c} to go`, async () => !(await a.scene()).cards.some((x) => x.id === c));
          }
          continue;
        }
        const r = rnd(), len = want.text.length;
        const newlines = [...want.text].flatMap((c, i) => (c === "\n" ? [i] : []));
        if (r < 0.22) {
          const t = pick(tokens);
          await step(`type ${JSON.stringify(t)}`, () => a.type(t), insert(t));
        } else if (r < 0.38) {
          const k = rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 2);
          await step(`Return ×${k}`, async () => { for (let i = 0; i < k; i++) await a.key("Enter"); }, insert("\n".repeat(k)));
        } else if (r < 0.52) {
          const k = Math.min(want.at, rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 4));
          await step(`⌫ ×${k}`, async () => { for (let i = 0; i < k; i++) await a.key("Backspace"); },
            (w) => ({ text: w.text.slice(0, w.at - k) + w.text.slice(w.at), at: w.at - k }));
        } else if (input === "touch") {
          // a tap on a character shown above the keyboard puts the caret beside it; not near the caret or where a tap put
          // it last, where Android draws a handle that Chrome takes taps on, which keys not typed on its keyboard leave.
          // Aimed once the keyboard has come and the board stands still, as a finger aimed before lands on the keyboard.
          await keyboard();
          await a.still("the keyboard and the board to stand still");
          const e = await a.editor();
          assert.ok(e, "nothing is being edited");
          const near = (c: Box, k: Box | null) => !!k && Math.abs(c.x + c.w / 2 - k.x) < 48 && c.y + c.h / 2 > k.y - k.h && c.y + c.h / 2 < k.y + 2 * k.h + 48;
          // nor under another card, which takes the tap and ends the edit
          const others = await Promise.all((await a.scene()).cards.filter((x) => x.id !== id).map((x) => onScreen(a, x.id)));
          const covered = (c: Box) => others.some((o) => c.x + c.w > o.x - 4 && c.x < o.x + o.w + 4 && c.y + c.h > o.y - 4 && c.y < o.y + o.h + 4);
          // nor under the 44 pt bar a phone shows over the keyboard, whose Turn a tap meant for the text pressed once
          const on = e.chars.flatMap((c, i) => c && c.y > e.view.y + 90 && c.y + c.h < e.view.y + e.view.h - 54 && !near(c, e.caret) && !near(c, tapped) && !covered(c) ? [[i, c] as const] : []);
          if (r < 0.9 && on.length) {
            const [i, c] = pick(on);
            const p = await a.world({ x: c.x + c.w / 2, y: c.y + c.h / 2 });
            await step(`tap on ${JSON.stringify(want.text[i])} at ${i}`, async () => {
              await a.tap(p);
              // as a person waits to see where it went, and so that the next tap is not a double tap
              await a.wait(400);
              tapped = (await a.editor())?.caret ?? null;
            }, theirs);
          } else {
            await end();
          }
        } else if (r < 0.62) {
          const k = Math.min(len - want.at, rnd() < 0.7 ? 1 : 2 + Math.floor(rnd() * 3));
          await step(`⌦ ×${k}`, async () => { for (let i = 0; i < k; i++) await a.key("Delete"); },
            (w) => ({ text: w.text.slice(0, w.at) + w.text.slice(w.at + k), at: w.at }));
        } else if (r < 0.76) {
          // beside a newline, where Return, ⌫ and ⌦ move the title's end
          const to = newlines.length ? pick(newlines) + (rnd() < 0.5 ? 0 : 1) : pick([0, len]);
          await step(`arrows to ${to}`, () => moveTo(to), (w) => ({ ...w, at: to }));
        } else if (r < 0.82) {
          const k = 1 + Math.floor(rnd() * 5), left = rnd() < 0.5;
          const to = Math.max(0, Math.min(len, want.at + (left ? -k : k)));
          await step(`${left ? "←" : "→"} ×${k}`, async () => { for (let i = 0; i < k; i++) await a.key(left ? "ArrowLeft" : "ArrowRight"); },
            (w) => ({ ...w, at: to }));
        } else if (r < 0.86) {
          const top = rnd() < 0.5;
          await step(top ? "⌘↑" : "⌘↓", () => a.key(top ? "ArrowUp" : "ArrowDown", { meta: true }), (w) => ({ ...w, at: top ? 0 : len }));
        } else if (r < 0.9) {
          const meta = rnd() < 0.5, k = pick(meta ? ["ArrowLeft", "ArrowRight"] : ["ArrowUp", "ArrowDown"]);
          await step(`${meta ? "⌘" : ""}${k}`, () => a.key(k, { meta }), theirs);
        } else if (r < 0.97 && len) {
          // a selection of up to 6 to the left or right, typed over or deleted. Where AppKit squeezes spaces that end a
          // wrapped line to nothing, ⇧-arrows select more or fewer and ⌫ deletes yet other characters, as in any Mac text
          // view: there the text is what the Mac made of it, still drawn as it should be.
          const k = 1 + Math.floor(rnd() * 6), left = rnd() < 0.5;
          const n = Math.abs(Math.max(0, Math.min(len, want.at + (left ? -k : k))) - want.at);
          const t = rnd() < 0.5 ? "" : rnd() < 0.3 ? "\n" : pick(tokens);
          let from = want.at, upto = want.at, squeezed = false;
          await step(`⇧${left ? "←" : "→"} ×${n}, then ${t ? JSON.stringify(t) : "⌫"}`, async () => {
            for (let i = 0; i < n; i++) await a.key(left ? "ArrowLeft" : "ArrowRight", { shift: true });
            const e = await a.editor();
            assert.ok(e, "nothing is being edited");
            [from, upto] = e.selected;
            squeezed = a.kind === "mac" && upto - from !== n;
            if (!squeezed) assert.equal(upto - from, n, `${n} ⇧-arrows selected ${JSON.stringify(e.text.slice(from, upto))}`);
            if (!t) await a.key("Backspace");
            else if (t === "\n") await a.key("Enter");
            else await a.type(t);
          }, async (w) => {
            if (squeezed) {
              log.push("(AppKit's squeezed spaces)");
              const e = await a.editor();
              assert.ok(e, "nothing is being edited");
              return { text: e.text, at: e.at };
            }
            return from === upto && !t
              ? { text: w.text.slice(0, Math.max(0, from - 1)) + w.text.slice(from), at: Math.max(0, from - 1) }
              : { text: w.text.slice(0, from) + t + w.text.slice(upto), at: from + t.length };
          });
        } else {
          await end();
        }
      }
      if (id) await end();
      await s.settle();
      const seen = new Map((await b.scene()).cards.map((c) => [c.id, c.text]));
      assert.deepEqual(seen, kept, "the other device's cards");
    } catch (e) {
      throw new Error(`CHAOS_SEED=${CHAOS_SEED}: ${(e as Error).message}\n  steps: ${log.join(" · ")}`, { cause: e });
    }
  },
});

export const cases: Case[] = [
  lines("mouse"),
  lines("touch"),
  wrapping("mouse"),
  wrapping("touch"),
  composed("mouse"),
  composed("touch"),
  chaos("mouse"),
  chaos("touch"),
  {
    name: "a card dragged into a lane shows at the top of the lane's column on the other device",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene();
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 });
      assert.equal(item(await b.scene(), card).held, false);
    },
  },
  {
    name: "a card held and dragged into a lane with a finger shows at the top of its column on the other device",
    input: "touch",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene();
      await a.touchDrag(press(item(at, card)), centre(item(at, lane)));
      await s.settle();
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 });
    },
  },
  {
    name: "a card dragged into a lane with a finger in the app launched without network shows there on the other device once online",
    input: "touch",
    offline: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const was = await within(b, lane, card);
      await a.offline(true);
      await a.relaunch();
      const at = await a.scene();
      await a.touchDrag(press(item(at, card)), centre(item(at, lane)));
      await a.wait(2000);
      assert.deepEqual(await within(a, lane, card), { x: 24, y: 72 }, "where it was dragged, offline");
      assert.deepEqual(await within(b, lane, card), was, "the other device saw it while the first was offline");
      await a.offline(false);
      // quality goal 3a: both show it 10 s after both are online
      const there = await eventually(b, 10_000, async () => JSON.stringify(await within(b, lane, card)) === JSON.stringify({ x: 24, y: 72 }));
      assert.ok(there, `the other device shows it at ${JSON.stringify(await within(b, lane, card))} 10 s after the first came online; the first says "${await a.syncStatus()}", the other "${await b.syncStatus()}"`);
    },
  },
  {
    name: "a lane dragged by its header carries the cards in it, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      let at = await a.scene();
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      at = await a.scene();
      const l = item(at, lane);
      await a.drag({ x: l.x + 100, y: l.y + 10 }, { x: l.x + 196, y: l.y + 58 });
      await s.settle();
      const seen = item(await b.scene(), lane);
      assert.deepEqual({ dx: seen.x - l.x, dy: seen.y - l.y }, { dx: 96, dy: 48 });
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 });
    },
  },
  {
    name: "a finger dragged across a card that is not selected without holding pans, and moves nothing on the other device",
    input: "touch",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const made = item(await a.scene(), card);
      await a.tap({ x: made.x + made.w + 100, y: made.y + made.h / 2 });
      await a.wait(400);
      const before = await a.scene(), seen = item(await b.scene(), card);
      const c = item(before, card);
      assert.equal(c.selected, false, "a tap on nothing clears the selection");
      await a.touchDrag(press(c), { x: c.x + 200, y: c.y - 100 }, { hold: false });
      await s.settle();
      const after = await a.scene();
      assert.notDeepEqual(after.camera, before.camera, "the camera moved");
      assert.deepEqual({ x: item(after, card).x, y: item(after, card).y }, { x: c.x, y: c.y }, "the card did not");
      assert.deepEqual({ x: item(await b.scene(), card).x, y: item(await b.scene(), card).y }, { x: seen.x, y: seen.y });
    },
  },
  {
    name: "a finger dragged across a card pans though the phone is busy for a moment just after it goes down",
    input: "touch",
    busy: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const made = item(await a.scene(), card);
      await a.tap({ x: made.x + made.w + 100, y: made.y + made.h / 2 });
      await a.wait(400);
      const before = await a.scene(), seen = item(await b.scene(), card);
      const c = item(before, card);
      // longer than a hold: the finger moved long before, but the moves reach the app after the hold's timer
      await a.busyAfterPress(500);
      await a.touchDrag(press(c), { x: c.x + 200, y: c.y - 100 }, { hold: false });
      await s.settle();
      const after = await a.scene();
      assert.deepEqual({ x: item(after, card).x, y: item(after, card).y }, { x: c.x, y: c.y }, "the card did not move");
      assert.notDeepEqual(after.camera, before.camera, "the camera moved");
      assert.deepEqual({ x: item(await b.scene(), card).x, y: item(await b.scene(), card).y }, { x: seen.x, y: seen.y });
    },
  },
  {
    name: "text typed into a card shows on the other device",
    input: "mouse",
    edits: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const before = item(await a.scene(), card).text;
      await a.typeInto(card, " and more");
      await s.settle();
      assert.equal(item(await b.scene(), card).text, `${before} and more`);
    },
  },
  {
    name: "a colour key recolours the card clicked on the other device",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      await a.click(centre(item(await a.scene(), card)));
      await a.key("3");
      await s.settle();
      assert.equal(item(await b.scene(), card).color, 3);
    },
  },
  {
    name: "⌫ deletes the card clicked, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      await a.click(centre(item(await a.scene(), card)));
      await a.key("Backspace");
      await s.settle();
      assert.equal((await b.scene()).cards.some((c) => c.id === card), false);
    },
  },
  {
    name: "⌘Z puts a card dragged into a lane back where it was, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene(), was = item(await b.scene(), card);
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      await s.settle();
      await a.key("z", { meta: true });
      await s.settle();
      const now = item(await b.scene(), card);
      assert.deepEqual({ x: now.x, y: now.y }, { x: was.x, y: was.y });
    },
  },
  {
    name: "a lane resized by its corner has that size on the other device",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane } = await laneAndCard(s);
      const l = item(await a.scene(), lane);
      await a.drag({ x: l.x + l.w - 6, y: l.y + l.h - 6 }, { x: l.x + l.w + 90, y: l.y + l.h - 102 });
      await s.settle();
      const seen = item(await b.scene(), lane);
      assert.deepEqual({ w: seen.w, h: seen.h }, { w: l.w + 96, h: l.h - 96 });
    },
  },
  {
    name: "a card dragged out of a stack lets the one below it close up, on the other device too",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      let at = await a.scene();
      await a.drag(centre(item(at, card)), centre(item(at, lane)));
      const l = item(at, lane);
      const second = await a.addCard(l.x + l.w + 200, l.y + 400);
      await s.settle();
      at = await a.scene();
      await a.drag(centre(item(at, second)), centre(item(at, lane)));
      await s.settle();
      assert.deepEqual(await within(b, lane, second), { x: 24, y: 72 + item(await b.scene(), card).h + 24 }, "stacked below the first");
      at = await a.scene();
      await a.drag(centre(item(at, card)), { x: l.x + l.w + 300, y: l.y + 100 });
      await s.settle();
      assert.deepEqual(await within(b, lane, second), { x: 24, y: 72 }, "closed up to the top");
    },
  },
  {
    name: "a card one device holds stays where it holds it when the other drags it",
    input: "mouse",
    // a phone's screen does not show the card where the other made it, so its drag would miss it
    watches: ["chromium", "webkit", "firefox", "mac"],
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane, card } = await laneAndCard(s);
      const at = await a.scene();
      const c = centre(item(at, card)), l = centre(item(at, lane));
      const [pa, pl] = [await a.screen(c), await a.screen(l)];
      await a.pointer("down", pa);
      await a.pointer("move", { x: pa.x - 20, y: pa.y + 20 });
      await a.wait(100);
      await s.settle();
      const bs = await b.scene();
      const target = { x: item(bs, card).x + 300, y: item(bs, card).y + 300 };
      await b.drag(centre(item(bs, card)), target);
      await b.wait(100);
      const tried = item(await b.scene(), card);
      assert.ok(Math.abs(tried.x - target.x) > 100, `the other device could not move it (at ${tried.x}, dragged to about ${target.x})`);
      await a.pointer("move", pl);
      await a.wait(50);
      await a.pointer("up", pl);
      await s.settle();
      assert.deepEqual(await within(b, lane, card), { x: 24, y: 72 }, "where the holder put it");
      assert.deepEqual(await within(a, lane, card), { x: 24, y: 72 });
    },
  },
  {
    name: "a card made with a double tap and typed into on a phone shows its text on the other device",
    input: "touch",
    edits: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane } = await laneAndCard(s);
      const l = item(await a.scene(), lane);
      const had = new Set((await a.scene()).cards.map((c) => c.id));
      await a.doubleTap({ x: l.x + l.w + 150, y: l.y + 450 });
      await a.wait(300);
      await a.type("from the phone");
      // a tap on the board ends the edit, as there is no Esc on a phone: just above the card, which the board keeps in
      // sight of the keyboard
      const card = (await a.scene()).cards.find((c) => !had.has(c.id))!;
      await a.tap({ x: card.x + card.w / 2, y: card.y - 40 });
      await s.settle();
      const made = (await b.scene()).cards.filter((c) => !had.has(c.id));
      assert.deepEqual(made.map((c) => c.text), ["from the phone"]);
    },
  },
  {
    // the iOS escape of 2026-10-25: the zoom to 100 % left the caret off screen until the first key
    name: "a card made with a double tap at 25 % zoom on a phone is in sight before any key",
    input: "touch",
    edits: true,
    async run(s) {
      const [a] = s.devices as [Device, Device];
      await laneAndCard(s);
      // zoomed out as far as it goes with one finger, as in Maps: a tap, then a touch dragged up
      const size = await a.size(), from = { x: size.w / 2, y: size.h * 0.75 };
      const up: Frame[] = [];
      for (let i = 1; i <= 20; i++) up.push([16, "move", [[0, { x: from.x, y: from.y - 20 * i }]]]);
      await a.gesture([[0, "down", [[0, from]]], [40, "up", [[0, from]]], [100, "down", [[0, from]]], ...up, [100, "up", [[0, { x: from.x, y: from.y - 400 }]]]]);
      await a.still("the zoom to settle");
      assert.ok((await a.scene()).camera.zoom < 0.3, `zoom ${(await a.scene()).camera.zoom}`);
      // low and to the right, where the card fits at 25 % but at 100 % reaches past the edge, and the keyboard comes
      // up over it
      await a.doubleTap(await a.world({ x: size.w - 100, y: size.h * 0.57 }));
      await a.still("the zoom and the keyboard to settle");
      assert.ok(Math.abs((await a.scene()).camera.zoom - 1) < 0.01, "fingers edit at 100 %");
      await a.type("x");
    },
  },
  {
    name: "a lane renamed from its header has the new name on the other device",
    input: "mouse",
    edits: true,
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { lane } = await laneAndCard(s);
      await a.rename(lane, "Doing");
      await s.settle();
      assert.equal(item(await b.scene(), lane).title, "Doing");
    },
  },
  {
    name: "a box drawn on empty space selects the cards it touches, and the other device sees nothing move",
    input: "mouse",
    async run(s) {
      const [a, b] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const c = item(await a.scene(), card), seen = item(await b.scene(), card);
      await a.drag({ x: c.x + c.w + 60, y: c.y + c.h + 60 }, { x: c.x + 20, y: c.y + 20 });
      assert.equal(item(await a.scene(), card).selected, true);
      await s.settle();
      assert.deepEqual({ x: item(await b.scene(), card).x, y: item(await b.scene(), card).y }, { x: seen.x, y: seen.y });
    },
  },
  {
    name: "Space turns the card under the pointer over, and again turns it back",
    input: "mouse",
    async run(s) {
      const [a] = s.devices as [Device, Device];
      const { card } = await laneAndCard(s);
      const c = centre(item(await a.scene(), card));
      await a.click(c);
      await a.key(" ");
      assert.equal((await a.scene()).turned, card);
      await a.key(" ");
      assert.equal((await a.scene()).turned, null);
    },
  },
  {
    name: "two fingers spreading apart zoom in about their middle",
    input: "touch",
    fingers: 2,
    async run(s) {
      const [a] = s.devices as [Device, Device];
      await laneAndCard(s);
      const before = (await a.scene()).camera;
      const size = await a.size(), m = { x: size.w / 2, y: size.h / 2 };
      const spread: Frame[] = [];
      for (let i = 1; i <= 10; i++) spread.push([16, "move", [[1, { x: m.x - 50 - 5 * i, y: m.y }], [2, { x: m.x + 50 + 5 * i, y: m.y }]]]);
      await a.gesture([
        [0, "down", [[1, { x: m.x - 50, y: m.y }]]],
        [0, "down", [[2, { x: m.x + 50, y: m.y }]]],
        ...spread,
        [0, "up", [[1, { x: m.x - 100, y: m.y }]]],
        [0, "up", [[2, { x: m.x + 100, y: m.y }]]],
      ]);
      await a.wait(1500);
      const { camera } = await a.scene();
      const zoom = Math.min(2, before.zoom * 2);
      assert.ok(Math.abs(camera.zoom - zoom) < 0.02, `zoom ${camera.zoom}, the fingers' spread doubled from ${before.zoom}`);
      // the world point first under the fingers' middle stays there, within a few points: a browser hands the app one
      // finger's move at a time, so the middle wobbles between them and the release may coast a little
      const w0 = (m.x - before.x) / before.zoom, w1 = (m.x - camera.x) / camera.zoom;
      assert.ok(Math.abs(w1 - w0) < 4, `world x ${w1} under the middle, was ${w0}`);
    },
  },
];
