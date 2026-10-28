// The server's contract: seeded random calls played against sync.php (server/test/contract.test.mjs) and against the
// fakes the unit tests stand it in with, this folder's FakeServer and BreezyKit's (ServerContractTests.swift), which
// must answer alike. Each call is chosen from what the real server answered; an epoch is named by what a device knows
// of it, as each side makes its own.
import { encode } from "../../sync/base64.ts";
import { FakeServer, mulberry } from "./fake-server.ts";
import type { Page, PushResult, Sealed, Write } from "../../sync/engine.ts";

/** The epoch a push names: the last one its device saw, the one before, or one no server gave. */
export type EpochRef = "current" | "previous" | "unknown";

export type Step =
  | { op: "pull"; since: number }
  | { op: "push"; writes: Write[]; since?: number; epoch?: EpochRef }
  /** A backup put back, which gives the space a new epoch. */
  | { op: "restore" }
  /** The space lost. */
  | { op: "wipe" };

/** A server as the contract drives it. */
export interface Side {
  pull(since: number): Promise<Page>;
  push(writes: Write[], since?: number, epoch?: string): Promise<PushResult>;
  restore(): Promise<void>;
  wipe(): Promise<void>;
}

/** An epoch no server gave: 16 bytes, as sync.php takes one. */
export const UNKNOWN = "AAAAAAAAAAAAAAAAAAAAAA";

/** Plays steps on `side` as one device would, naming each answer's epochs E0, E1, … in the order they came. */
export class Player {
  private readonly names = new Map<string, string>();
  /** The epochs seen, newest last. */
  private readonly seen: string[] = [];

  private readonly side: Side;

  constructor(side: Side) {
    this.side = side;
  }

  /** The side's answer, and as compared: null for a restore or a wipe. */
  async play(step: Step): Promise<{ answer: Page | PushResult | null; normal: unknown }> {
    if (step.op === "restore" || step.op === "wipe") {
      await this.side[step.op]();
      return { answer: null, normal: null };
    }
    const answer = step.op === "pull" ? await this.side.pull(step.since) : await this.side.push(step.writes, step.since, this.epoch(step.epoch));
    if (answer.epoch !== null && this.seen.at(-1) !== answer.epoch) this.seen.push(answer.epoch);
    return { answer, normal: this.normal(answer) };
  }

  private epoch(ref?: EpochRef): string | undefined {
    if (ref === "unknown") return UNKNOWN;
    if (ref === "current") return this.seen.at(-1);
    if (ref === "previous") return this.seen.at(-2);
    return undefined;
  }

  private name(epoch: string | null): string | null {
    if (epoch === null) return null;
    if (!this.names.has(epoch)) this.names.set(epoch, `E${this.names.size}`);
    return this.names.get(epoch)!;
  }

  private normal(a: Page | PushResult): unknown {
    const rec = (r: Sealed) => ({ id: r.id, version: r.version, blob: r.blob, ...(r.stale ? { stale: true } : {}) });
    return {
      ...("accepted" in a ? { accepted: a.accepted.map(({ id, version }) => ({ id, version })), refused: a.refused.map(rec) } : {}),
      epoch: this.name(a.epoch),
      ...(a.cursor === undefined ? {} : { cursor: a.cursor }),
      ...(a.records ? { records: a.records.map(rec) } : {}),
      ...(a.relay === undefined ? {} : { relay: a.relay }),
    };
  }
}

/** Steps from `seed`, each chosen from what the real server answered to those before: `saw` takes its answer. */
export function generator(seed: number) {
  const rnd = mulberry(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(rnd() * xs.length)]!;
  const bytes = (n: number) => encode(Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256)));
  const ids = Array.from({ length: 5 }, () => bytes(16));
  const known = new Map<string, number>();
  let top = 0, cursor = 0;
  const epochs = new Set<string>();
  const since = () => pick([0, cursor, top, Math.floor(rnd() * (top + 3))]);
  const epoch = (): EpochRef | undefined => pick([undefined, "unknown", ...(epochs.size ? ["current", "current"] as const : []), ...(epochs.size > 1 ? ["previous"] as const : [])]);
  return {
    next(): Step {
      const r = rnd();
      if (r < 0.04) return { op: "restore" };
      if (r < 0.07) return { op: "wipe" };
      // past a page of the server's
      if (r < 0.09) return { op: "push", writes: Array.from({ length: 501 + Math.floor(rnd() * 20) }, () => ({ id: bytes(16), base: 0, blob: bytes(28) })) };
      if (r < 0.4) return { op: "pull", since: since() };
      const writes = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => {
        const id = pick(ids), v = known.get(id) ?? 0;
        return { id, base: pick([v, v, 0, v + 1, Math.max(0, v - 1)]), blob: bytes(28 + Math.floor(rnd() * 40)) };
      });
      return { op: "push", writes, ...(rnd() < 0.5 ? { since: since() } : {}), ...((e) => (e ? { epoch: e } : {}))(epoch()) };
    },
    saw(step: Step, answer: Page | PushResult | null) {
      if (step.op === "wipe") {
        known.clear();
        top = cursor = 0;
      }
      if (!answer) return;
      const records = [...("accepted" in answer ? [...answer.accepted, ...answer.refused] : []), ...(answer.records ?? [])];
      for (const { id, version } of records) {
        known.set(id, version);
        top = Math.max(top, version);
      }
      if (answer.cursor !== undefined) cursor = answer.cursor;
      if (answer.epoch !== null) epochs.add(answer.epoch);
    },
  };
}

/** The unit tests' FakeServer as a side. */
export function fakeSide(server = new FakeServer()): Side {
  return {
    pull: async (since) => structuredClone(server.pull(since)),
    push: async (writes, since, epoch) => structuredClone(server.push(writes, since, epoch)),
    restore: async () => server.restore(server.snapshot()),
    wipe: async () => server.wipe(),
  };
}
