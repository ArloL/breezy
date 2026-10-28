// Mac/web parity on the cores: the same steps on the Swift core and the web core end with the same scene and take the
// same transitions on the way, as each one's recorder (web/flight.ts, BreezyKit's Flight.swift) has them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { World, type Device, type Scene, type SimDevice } from "../world.ts";
import type { Entry, Value } from "../../web/flight.ts";

export type Steps = (d: Device, made: string[]) => Promise<void>;

/** Ids are random per device, so items go by their order of first sight: made, then as scenes show them. */
class Names {
  private ids: string[] = [];
  add(id: string) {
    if (!this.ids.includes(id)) this.ids.push(id);
  }
  see(s: Scene) {
    for (const i of [...s.cards, ...s.lanes]) this.add(i.id);
  }
  of = (v: Value): Value => {
    if (typeof v === "string") return this.ids.includes(v) ? `#${this.ids.indexOf(v)}` : v;
    if (Array.isArray(v)) return v.map(this.of);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, this.of(x)]));
    return v;
  };
}

/** Without the camera: the Mac moves it in its view, not in BreezyKit, so the Swift core's never moves. Through JSON, as
 * a snap to the grid gives one core -0 where the other has 0. */
function comparable(s: Scene, names: Names) {
  const strip = ({ id, ...rest }: { id: string }) => ({ id: names.of(id), ...rest });
  const c = { cards: s.cards.map(strip), lanes: s.lanes.map(strip), turned: s.turned && names.of(s.turned), marquee: s.marquee };
  return JSON.parse(JSON.stringify(c)) as typeof c;
}

/** Every entry the device has recorded, oldest first, numbered from `from`, counting those the ring let go. */
async function entries(d: Device) {
  const r = await d.flight();
  if (!r) throw new Error(`${d.kind} keeps no recording`);
  return { from: r.dropped, entries: r.entries };
}

export type Observed = { scene: ReturnType<typeof comparable>; transitions: Value[] };

/** What each of `steps` left on one core of `kind`, after `setUp`: its scene and the transitions it took, without times. */
export async function play(kind: "swift" | "web", setUp: Steps, steps: Steps[]): Promise<Observed[]> {
  const w = await World.start([kind]);
  try {
    const [d] = w.devices as [SimDevice];
    const names = new Names(), made: string[] = [];
    await setUp(d, made);
    await w.settle();
    for (const id of made) names.add(id);
    let { from, entries: all } = await entries(d);
    let since = from + all.length;
    const seen: Observed[] = [];
    for (const step of steps) {
      await step(d, made);
      await w.settle();
      const s = await d.scene();
      names.see(s);
      ({ from, entries: all } = await entries(d));
      if (from > since) throw new Error(`${kind}'s recorder let go of entries a step made`);
      const transitions = all.slice(since - from).filter((e: Entry) => e[1] === "transition").map(([, , what, data]) => data ? [what, names.of(data)] : [what]);
      since = from + all.length;
      seen.push({ scene: comparable(s, names), transitions });
    }
    return seen;
  } finally {
    w.stop();
  }
}

/** The first step after which the cores differ, and how; null when they agree throughout. */
export async function differ(setUp: Steps, steps: Steps[]) {
  const [swift, web] = [await play("swift", setUp, steps), await play("web", setUp, steps)];
  const at = swift.findIndex((s, i) => !isDeepStrictEqual(s, web[i]));
  return at < 0 ? null : { at, swift: swift[at]!, web: web[at]! };
}

/** A test that `act`, after `setUp`, leaves both cores with the same scene, by the same transitions. */
export function parity(name: string, setUp: Steps, act: Steps) {
  test(`the cores agree: ${name}`, async () => {
    const d = await differ(setUp, [act]);
    if (!d) return;
    assert.deepEqual(d.web.transitions, d.swift.transitions, "web's transitions against Swift's");
    assert.deepEqual(d.web.scene, d.swift.scene, "web's scene against Swift's");
  });
}
