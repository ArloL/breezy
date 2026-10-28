// Mac/web parity on the cores: the same steps on the Swift core and the web core end with the same scene and take the
// same transitions on the way, as each one's recorder (web/flight.ts, BreezyKit's Flight.swift) has them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { World, type Device, type Scene, type SimDevice } from "../world.ts";
import type { Entry, Value } from "../../web/flight.ts";

export type Steps = (d: Device, made: string[]) => Promise<void>;

/** Ids are random per device, so items go by their order of making. */
const namer = (made: string[]) => (id: string) => made.includes(id) ? `#${made.indexOf(id)}` : id;

function rename(v: Value, name: (id: string) => string): Value {
  if (typeof v === "string") return name(v);
  if (Array.isArray(v)) return v.map((x) => rename(x, name));
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, rename(x, name)]));
  return v;
}

function comparable(s: Scene, made: string[]) {
  const name = namer(made);
  const strip = ({ id, ...rest }: { id: string }) => ({ id: name(id), ...rest });
  return { cards: s.cards.map(strip), lanes: s.lanes.map(strip), turned: s.turned && name(s.turned), marquee: s.marquee, camera: s.camera };
}

/** Every entry the device has recorded, oldest first, counting those the ring let go. */
async function entries(d: Device) {
  const r = await d.flight();
  if (!r) throw new Error(`${d.kind} keeps no recording`);
  return { from: r.dropped, entries: r.entries };
}

/** The transitions taken since entry `since`, without their times. */
async function transitions(d: Device, since: number, made: string[]) {
  const { from, entries: all } = await entries(d);
  if (from > since) throw new Error(`${d.kind}'s recorder let go of entries the steps made`);
  const name = namer(made);
  return all.slice(since - from).filter((e: Entry) => e[1] === "transition").map(([, , what, data]) => data ? [what, rename(data, name)] : [what]);
}

/** A test that `act`, after `setUp`, leaves both cores with the same scene, by the same transitions. */
export function parity(name: string, setUp: Steps, act: Steps) {
  test(`the cores agree: ${name}`, async () => {
    const results = [];
    for (const kind of ["swift", "web"] as const) {
      const w = await World.start([kind]);
      try {
        const [d] = w.devices as [SimDevice];
        const made: string[] = [];
        await setUp(d, made);
        await w.settle();
        const before = await entries(d);
        await act(d, made);
        await w.settle();
        results.push({ kind, scene: comparable(await d.scene(), made), transitions: await transitions(d, before.from + before.entries.length, made) });
      } finally {
        w.stop();
      }
    }
    const [swift, web] = results;
    assert.deepEqual(web!.transitions, swift!.transitions, "web's transitions against Swift's");
    assert.deepEqual(web!.scene, swift!.scene, "web's scene against Swift's");
  });
}
