// Mac/web parity on the cores: the same steps on the Swift core and the web core end with the same scene and note the
// same input and transitions on the way, each one's recorder (web/flight.ts, BreezyKit's Flight.swift) writing a
// recording of the same shape.
import { test } from "node:test";
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { World, type Device, type Scene, type SimDevice } from "../world.ts";
import type { Entry, Kind, Value } from "../../web/flight.ts";

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

const KINDS: Record<Kind, true> = { context: true, geometry: true, decision: true, transition: true, input: true, sync: true, life: true, timing: true, error: true };
const isObject = (v: unknown) => typeof v === "object" && v !== null && !Array.isArray(v);

/** What is wrong with `r` as web/flight.ts's `Recording`, or null when nothing is. */
export function misshapen(r: unknown): string | null {
  if (!isObject(r)) return "not an object";
  const o = r as Record<string, unknown>;
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "context,dropped,entries,origin,schema") return `keys ${keys}`;
  if (o.schema !== 1) return `schema ${String(o.schema)}`;
  if (typeof o.origin !== "number" || !Number.isFinite(o.origin)) return `origin ${String(o.origin)}`;
  if (!Number.isInteger(o.dropped) || (o.dropped as number) < 0) return `dropped ${String(o.dropped)}`;
  if (o.context !== null && !isObject(o.context)) return "context neither an object nor null";
  if (!Array.isArray(o.entries)) return "entries not an array";
  let last = -Infinity;
  for (const [i, e] of (o.entries as unknown[]).entries()) {
    if (!Array.isArray(e) || (e.length !== 3 && e.length !== 4)) return `entry ${i} not [t, kind, what, data?]`;
    const [t, kind, what, data] = e as unknown[];
    if (typeof t !== "number" || t < last) return `entry ${i}'s t ${String(t)} after ${last}`;
    if (!Object.hasOwn(KINDS, kind as string)) return `entry ${i}'s kind ${String(kind)}`;
    if (typeof what !== "string") return `entry ${i}'s what ${String(what)}`;
    if (e.length === 4 && !isObject(data)) return `entry ${i}'s data not an object`;
    last = t;
  }
  return null;
}

/** Every entry the device has recorded, oldest first, numbered from `from`, counting those the ring let go. */
async function entries(d: Device) {
  const r = await d.flight();
  if (!r) throw new Error(`${d.kind} keeps no recording`);
  const wrong = misshapen(r);
  if (wrong) throw new Error(`${d.kind}'s recording is not web/flight.ts's: ${wrong}`);
  return { from: r.dropped, entries: r.entries };
}

/** What both cores note; not their decisions, as the Mac makes its reveals in its view, not in BreezyKit. */
const SHARED: Kind[] = ["input", "transition"];

/** Without where on the screen a press was, which the camera decides, left out as `comparable` leaves it. */
const shared = ([, kind, what, data]: Entry, names: Names): Value => {
  if (!data) return [kind, what];
  const { x, y, ...rest } = data;
  return [kind, what, names.of(kind === "input" ? rest : data)];
};

export type Observed = { scene: ReturnType<typeof comparable>; noted: Value[] };

/** What each of `steps` left on one core of `kind`, after `setUp`: its scene and its input and transitions, without times. */
export async function play(kind: "swift" | "web", setUp: Steps, steps: Steps[]): Promise<Observed[]> {
  const w = await World.start([kind]);
  try {
    const [d] = w.devices as [SimDevice];
    // a browser opens a board at ×0.75; the Swift core's camera stays where it starts
    if (kind === "web") await w.hub.command(d.d, { cmd: "camera", cam: { x: 0, y: 0, zoom: 1 } });
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
      const noted = all.slice(since - from).filter((e: Entry) => SHARED.includes(e[1])).map((e) => shared(e, names));
      since = from + all.length;
      seen.push({ scene: comparable(s, names), noted });
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

/** A test that `act`, after `setUp`, leaves both cores with the same scene, by the same input and transitions. */
export function parity(name: string, setUp: Steps, act: Steps) {
  test(`the cores agree: ${name}`, async () => {
    const d = await differ(setUp, [act]);
    if (!d) return;
    assert.deepEqual(d.web.noted, d.swift.noted, "web's input and transitions against Swift's");
    assert.deepEqual(d.web.scene, d.swift.scene, "web's scene against Swift's");
  });
}
