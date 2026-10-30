// What a scenario does with a device of any kind: input as a person gives it, and what the device shows.
import type { Point } from "../web/types.ts";
import type { Scene, SceneItem } from "../web/scene.ts";
import type { Sight } from "../web/test/fakes.ts";
import type { Recording } from "../web/flight.ts";

export type { Scene, SceneItem, Sight };

export interface Modifiers {
  shift?: boolean;
  option?: boolean;
}

export type PointerPhase = "down" | "move" | "up" | "cancel";

/** A frame of a gesture: the ms to wait first, and each finger's id and screen point. */
export type Frame = [ms: number, phase: PointerPhase, moves: [number, Point][]];

export interface PointerExtra extends Modifiers {
  /** 2 for the second press of a double-click. */
  clicks?: number;
  kind?: "mouse" | "touch";
  finger?: number;
}

/** A rectangle in screen points. */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** What the editor with the keyboard draws, in screen points. */
export interface Editor {
  text: string;
  /** The caret's offset in `text`. */
  at: number;
  /** What is selected, from the offset before to the one after: both `at` when nothing is. */
  selected: [number, number];
  caret: Box | null;
  /** Each character as drawn, null for a newline; a front may draw one more, the newline of an empty last line. */
  chars: (Box | null)[];
  /** Each character's font weight, 400 regular, 600 semibold. */
  weights: number[];
  /** Where the first line starts. */
  origin: { x: number; y: number };
  /** The line height. */
  line: number;
  /** What of the screen shows, less a phone's keyboard. */
  view: Box;
  /** The card being edited as drawn; null for a lane's title. */
  card: Box | null;
  /** What of the screen shows the board: the view less the bars over it. */
  board: Box;
  /** How `board` was read. */
  how?: string;
}

export abstract class Device {
  abstract readonly kind: string;
  /** A mouse or finger event at a screen point. */
  abstract pointer(phase: PointerPhase, p: Point, extra?: PointerExtra): Promise<void>;
  abstract scene(): Promise<Scene>;
  /** Lets `ms` pass on this device's clock. */
  abstract wait(ms: number): Promise<void>;
  /** A card at world point (x, y), made as this kind of device makes one; its id. */
  abstract addCard(x: number, y: number): Promise<string>;
  /** A lane centred near world point (x, y), where this kind of device puts one; its id. */
  abstract addLane(x: number, y: number): Promise<string>;

  /** A key as Playwright names it ("3", "Backspace", " ", "z"), with ⌘ (`meta`) or ⇧ held; "disabled" where the menu
   * item it presses is greyed out and did nothing, as on the Mac. */
  abstract key(key: string, mods?: { meta?: boolean; shift?: boolean }): Promise<void | "disabled">;

  /** Its screen in points: the scenarios' 1200 × 800 window, but on a phone. */
  async size() {
    return { w: 1200, h: 800 };
  }

  /** Whether `typeInto` works: the hub's fakes have no editor yet. */
  get edits() {
    return false;
  }

  /** Types `text` into whatever has the keyboard. */
  async type(_text: string): Promise<void> {
    throw new Error(`${this.kind} devices cannot edit`);
  }

  /** Sets the text an input method is composing at the caret to `text`, as a keyboard does as each key of a word is
   * pressed; null commits it, as the keyboard does at the word's end or as the edit ends. */
  async compose(_text: string | null): Promise<void> {
    throw new Error(`${this.kind} devices have no input method`);
  }

  /** Types `text` at the end of card `id`'s front, as a person does: a double-click, the keys, and Esc. */
  async typeInto(_id: string, _text: string): Promise<void> {
    throw new Error(`${this.kind} devices cannot edit`);
  }

  /** Whether `editor` works: the hub's fakes draw no text. */
  get draws() {
    return false;
  }

  /** What the editor with the keyboard draws, or null when nothing is being edited. */
  async editor(): Promise<Editor | null> {
    throw new Error(`${this.kind} devices draw no text`);
  }

  /** The weight of each character of card `id`'s front but its newlines, as drawn while not edited, or null where it is drawn from its
   * text alone, as on the Mac, or once it is gone. */
  async weights(_id: string): Promise<number[] | null> {
    throw new Error(`${this.kind} devices draw no text`);
  }

  /** Keeps the app's main thread busy for `ms` just after the next finger goes down, as a phone busy with something
   * else: what the finger does meanwhile reaches the app late. */
  async busyAfterPress(_ms: number): Promise<void> {
    throw new Error(`${this.kind} devices cannot be kept busy`);
  }

  /** Cuts this device off the network (`off`) or puts it back, as airplane mode does. */
  async offline(_off: boolean): Promise<void> {
    throw new Error(`${this.kind} devices cannot go offline`);
  }

  /** What the app says of its sync, for a failure to tell where a change stopped. */
  async syncStatus(): Promise<string> {
    return "";
  }

  /** How many changes wait to be pushed, which a board shown alike everywhere does not say: what a device made can show
   * on another from the live layer before the server has it. */
  async unpushed(): Promise<number> {
    return 0;
  }

  /** Opens `url` in the device's browser, as a person follows a link. */
  async open(_url: string): Promise<void> {
    throw new Error(`${this.kind} devices follow no links`);
  }

  /** The title of the question the app asks, its sheet's, or null when it asks none. */
  async sheet(): Promise<string | null> {
    throw new Error(`${this.kind} devices show no sheets`);
  }

  /** A tap or click on the first element `selector` finds that shows, and whose text is `text` when given. */
  async tapOn(_selector: string, _text?: string): Promise<void> {
    throw new Error(`${this.kind} devices find no elements`);
  }

  /** A tap on what `selector` finds, which reads the clipboard, and on what the system then shows to allow it, where it
   * shows something. */
  async tapToPaste(selector: string): Promise<void> {
    await this.tapOn(selector);
  }

  /** The plain text on its clipboard, as another app pastes it. */
  async clipboard(): Promise<string> {
    throw new Error(`${this.kind} devices cannot read their clipboard`);
  }

  /** The HTML on its clipboard, as another app pastes it. */
  async clipboardHTML(): Promise<string> {
    throw new Error(`${this.kind} devices cannot read their clipboard`);
  }

  /** Puts `html` and `text` on its clipboard, as another app copying them does. */
  async putOnClipboard(_html: string, _text: string): Promise<void> {
    throw new Error(`${this.kind} devices cannot write their clipboard`);
  }

  /** Starts the app again, as a phone does after the system ended it, and opens the board it showed. */
  async relaunch(): Promise<void> {
    throw new Error(`${this.kind} devices cannot launch again`);
  }

  /** The card being edited, its caret and what of the screen shows the board, for a case to check it is in sight; null
   * when nothing is being edited or the device cannot tell. */
  async sight(): Promise<Sight | null> {
    if (!this.draws) return null;
    const e = await this.editor();
    return e && { focus: e.card, caret: e.caret, visible: e.board, how: e.how };
  }

  /** What its app recorded, or null where no app records: the Mac's, until BreezyKit does. */
  async flight(): Promise<Recording | null> {
    return null;
  }

  /** What it shows now, in a line, for a step log. */
  async state(): Promise<string> {
    const s = await this.scene(), c = s.camera;
    const ids = (f: (i: SceneItem) => boolean | undefined) => [...s.cards, ...s.lanes].filter(f).map((i) => i.id.slice(0, 8)).join(" ");
    const marks = { selected: ids((i) => i.selected), held: ids((i) => i.held), raised: ids((i) => i.raised), turned: s.turned?.slice(0, 8) };
    return [`${s.cards.length} cards, ${s.lanes.length} lanes, camera ${Math.round(c.x)},${Math.round(c.y)} ×${c.zoom.toFixed(2)}`,
      ...Object.entries(marks).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`), ...s.marquee ? ["marquee"] : []].join(", ");
  }

  /** Where world point `p` is on this device's screen now. */
  async screen(p: Point): Promise<Point> {
    const { camera: c } = await this.scene();
    return { x: p.x * c.zoom + c.x, y: p.y * c.zoom + c.y };
  }

  /** The world point at screen point `p` now. */
  async world(p: Point): Promise<Point> {
    const { camera: c } = await this.scene();
    return { x: (p.x - c.x) / c.zoom, y: (p.y - c.y) / c.zoom };
  }

  /** A mouse pressed at world point `from`, moved to `to` in `steps`, and let go. */
  async drag(from: Point, to: Point, { steps = 8, ms = 16, ...mods }: Modifiers & { steps?: number; ms?: number } = {}) {
    const [a, b] = [await this.screen(from), await this.screen(to)];
    await this.pointer("down", a, mods);
    await this.moveAlong(a, b, steps, ms, (p) => this.pointer("move", p, mods));
    await this.pointer("up", b, mods);
  }

  async click(p: Point, mods: Modifiers = {}) {
    const s = await this.screen(p);
    await this.pointer("down", s, mods);
    await this.pointer("up", s, mods);
  }

  /**
   * A finger on world point `from`, held still past a hold first when `hold`, moved to `to` and lifted. A held card is
   * moved only once it lifts, as a person waits to see it: a busy phone reads the touch late.
   */
  async touchDrag(from: Point, to: Point, { hold = true, steps = 8, ms = 16 }: { hold?: boolean; steps?: number; ms?: number } = {}) {
    const [a, b] = [await this.screen(from), await this.screen(to)];
    const card = hold ? (await this.scene()).cards.findLast((c) => from.x >= c.x && from.x < c.x + c.w && from.y >= c.y && from.y < c.y + c.h)?.id : undefined;
    const path: Frame[] = [];
    for (let i = 1; i <= steps; i++) path.push([ms, "move", [[0, { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps }]]]);
    path.push([ms, "up", [[0, b]]]);
    if (!card) {
      path[0]![0] += hold ? 400 : ms;
      return this.gesture([[0, "down", [[0, a]]], ...path]);
    }
    await this.gesture([[0, "down", [[0, a]]]]);
    await this.wait(400);
    await this.until(`${card} to lift under the finger`, async () => item(await this.scene(), card).raised === true);
    await this.gesture(path);
  }

  /** A double-click at world point `p`. */
  async doubleClick(p: Point) {
    const s = await this.screen(p);
    await this.pointer("down", s);
    await this.pointer("up", s);
    await this.pointer("down", s, { clicks: 2 });
    await this.pointer("up", s, { clicks: 2 });
  }

  /** Renames lane `id` as a person does: a double-click on its header, the name over the old one, and Return. */
  async rename(id: string, title: string) {
    const l = (await this.scene()).lanes.find((x) => x.id === id);
    if (!l) throw new Error(`nothing shows ${id}`);
    await this.doubleClick({ x: l.x + l.w / 2, y: l.y + 12 });
    await this.selectAll();
    await this.type(title);
    await this.key("Enter");
  }

  /** Selects all of what has the keyboard, as ⌘A does in a text field. */
  async selectAll() {
    await this.key("a", { meta: true });
  }

  /** Fingers moving together, as a phone reports them in one touch event: finger and screen point each. */
  async fingers(phase: PointerPhase, moves: [number, Point][]) {
    for (const [finger, p] of moves) await this.pointer(phase, p, { kind: "touch", finger });
  }

  /** Frames of fingers, each after its wait in ms: a gesture whose timing is what it means, as a hold's or a double tap's. */
  async gesture(frames: Frame[]) {
    for (const [ms, phase, moves] of frames) {
      if (ms) await this.wait(ms);
      await this.fingers(phase, moves);
    }
  }

  /** Two taps at world point `p`, as quick as a double tap. */
  async doubleTap(p: Point) {
    const s = await this.onScreen(p);
    await this.gesture([[0, "down", [[0, s]]], [40, "up", [[0, s]]], [60, "down", [[0, s]]], [40, "up", [[0, s]]]]);
  }

  async tap(p: Point) {
    const s = await this.onScreen(p);
    await this.gesture([[0, "down", [[0, s]]], [50, "up", [[0, s]]]]);
  }

  /** Where world point `p` is on the screen, which it must be: above it, an iPhone's status bar takes the touch, and the
   * page never hears of it. */
  protected async onScreen(p: Point) {
    const s = await this.screen(p), { w, h } = await this.size();
    if (s.x < 0 || s.x > w || s.y < 0 || s.y > h) throw new Error(`a tap at ${Math.round(s.x)},${Math.round(s.y)}, off the screen of ${w} × ${h}`);
    return s;
  }

  /** Until the board stands still, as a person waits to aim: on a phone, it moves as the keyboard comes and goes. */
  async still(_what: string): Promise<void> {}

  /** Until `test` holds, checked every 50 ms on this device's clock for at most `ms`. */
  async until(what: string, test: () => Promise<boolean>, ms = 5000) {
    for (let t = 0; !(await test()); t += 50) {
      if (t >= ms) throw new Error(`timed out after ${ms} ms: ${what}`);
      await this.wait(50);
    }
  }



  private async moveAlong(a: Point, b: Point, steps: number, ms: number, move: (p: Point) => Promise<void>) {
    for (let i = 1; i <= steps; i++) {
      await this.wait(ms);
      await move({ x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps });
    }
    await this.wait(ms);
  }
}

export const centre = (r: { x: number; y: number; w: number; h: number }): Point => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });

export function item(s: Scene, id: string): SceneItem {
  const found = s.cards.find((c) => c.id === id) ?? s.lanes.find((l) => l.id === id);
  if (!found) throw new Error(`nothing shows ${id}`);
  return found;
}

/** The page's recording, or null where its build has no recorder. Runs in the page. */
export function readFlight(): Recording | null {
  return (globalThis as { breezyFlight?: { recording(): Recording } }).breezyFlight?.recording() ?? null;
}
