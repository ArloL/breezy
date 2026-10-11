// What a scenario does with a device of any kind: input as a person gives it, and what the device shows.
import type { Point } from "../web/types.ts";
import type { Scene, SceneItem } from "../web/scene.ts";

export type { Scene, SceneItem };

export interface Modifiers {
  shift?: boolean;
  option?: boolean;
}

export type PointerPhase = "down" | "move" | "up" | "cancel";

export interface PointerExtra extends Modifiers {
  /** 2 for the second press of a double-click. */
  clicks?: number;
  kind?: "mouse" | "touch";
  finger?: number;
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

  /** A key as Playwright names it ("3", "Backspace", " ", "z"), with ⌘ (`meta`) or ⇧ held. */
  abstract key(key: string, mods?: { meta?: boolean; shift?: boolean }): Promise<void>;

  /** Whether `typeInto` works: the hub's fakes have no editor yet. */
  get edits() {
    return false;
  }

  /** Types `text` into whatever has the keyboard. */
  async type(_text: string): Promise<void> {
    throw new Error(`${this.kind} devices cannot edit`);
  }

  /** Types `text` at the end of card `id`'s front, as a person does: a double-click, the keys, and Esc. */
  async typeInto(_id: string, _text: string): Promise<void> {
    throw new Error(`${this.kind} devices cannot edit`);
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

  /** A finger on world point `from`, held still past a hold first when `hold`, moved to `to` and lifted. */
  async touchDrag(from: Point, to: Point, { hold = true, steps = 8, ms = 16 }: { hold?: boolean; steps?: number; ms?: number } = {}) {
    const [a, b] = [await this.screen(from), await this.screen(to)];
    const touch = { kind: "touch" as const };
    await this.pointer("down", a, touch);
    await this.wait(hold ? 400 : ms);
    await this.moveAlong(a, b, steps, ms, (p) => this.pointer("move", p, touch));
    await this.pointer("up", b, touch);
  }

  /** Two taps at world point `p`, as quick as a double tap. */
  async doubleTap(p: Point) {
    const s = await this.screen(p);
    for (let i = 0; i < 2; i++) {
      await this.pointer("down", s, { kind: "touch" });
      await this.wait(40);
      await this.pointer("up", s, { kind: "touch" });
      await this.wait(60);
    }
  }

  async tap(p: Point) {
    const s = await this.screen(p);
    await this.pointer("down", s, { kind: "touch" });
    await this.wait(50);
    await this.pointer("up", s, { kind: "touch" });
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
