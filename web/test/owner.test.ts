import { test } from "node:test";
import assert from "node:assert/strict";
import { ownBoards } from "../owner.ts";

type Ports = Parameters<typeof ownBoards>[0];
type Grant = (lock: { name: string } | null) => unknown;
type Tab = {
  channel: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (data: unknown) => void };
  locks: Pick<LockManager, "request">;
};
type Want = { tab: Tab; name: string; cb: Grant; resolve: (value: unknown) => void; reject: (reason: unknown) => void; stolen?: boolean };
type Seen = { tab: Tab; owns: boolean; waited: boolean; events: string[]; useHere: () => void; saved: () => void };

const aborted = () => new DOMException("aborted", "AbortError");

/** Web Locks and a BroadcastChannel shared by a device's tabs, as browsers have them; `close` ends a tab and frees what it
 * held. */
class Device {
  held: Map<string, Want>;
  queue: Want[];
  tabs: Tab[];

  constructor() {
    this.held = new Map();
    this.queue = [];
    this.tabs = [];
  }

  tab() {
    const tab = { channel: { onmessage: null, postMessage: (data: unknown) => this.post(tab, data) } } as Tab;
    tab.locks = {
      request: (name: string, options: LockOptions | Grant, cb?: Grant) => {
        if (typeof options === "function") [cb, options] = [options, {}];
        return new Promise<unknown>((resolve, reject) => {
          const want: Want = { tab, name, cb: cb!, resolve, reject };
          if (options.steal) {
            const old = this.held.get(name);
            if (old) (old.stolen = true), old.reject(aborted());
            return this.grant(want);
          }
          if (!this.held.has(name)) return this.grant(want);
          if (options.ifAvailable) return resolve(cb!(null));
          options.signal?.addEventListener("abort", () => {
            if (!this.queue.includes(want)) return;
            this.queue = this.queue.filter((w) => w !== want);
            reject(aborted());
          });
          this.queue.push(want);
        });
      },
    } as Pick<LockManager, "request">;
    this.tabs.push(tab);
    return tab;
  }

  post(from: Tab, data: unknown) {
    for (const t of this.tabs) if (t !== from) setTimeout(() => t.channel.onmessage?.({ data }));
  }

  grant(want: Want) {
    this.held.set(want.name, want);
    Promise.resolve(want.cb({ name: want.name })).then((r) => {
      if (want.stolen) return;
      this.release(want.name);
      want.resolve(r);
    });
  }

  release(name: string) {
    this.held.delete(name);
    const next = this.queue.findIndex((w) => w.name === name);
    if (next >= 0) this.grant(...(this.queue.splice(next, 1) as [Want]));
  }

  close(tab: Tab) {
    this.tabs = this.tabs.filter((t) => t !== tab);
    this.queue = this.queue.filter((w) => w.tab !== tab);
    for (const [name, w] of this.held) if (w.tab === tab) this.release(name);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 5));

/** Opens a tab: whether it owns the boards so far, whether it was told to wait, and what happened in order. A `slow` tab
 * saves on handing over only once `saved` is called. */
function open(device: Device, { slow = false } = {}) {
  const tab = device.tab();
  const seen = { tab, owns: false, waited: false, events: [] } as Partial<Seen> as Seen;
  ownBoards({
    locks: tab.locks,
    channel: tab.channel,
    waiting: (useHere) => {
      seen.waited = true;
      seen.useHere = useHere;
    },
    handOver: () => new Promise<void>((resolve) => {
      seen.saved = () => {
        seen.events.push("saved");
        resolve();
      };
      if (!slow) seen.saved();
    }),
    handedOver: () => seen.events.push("handed over"),
  }).then(() => (seen.owns = true));
  return seen;
}

test("without Web Locks, every tab owns the boards", async () => {
  let waited = false;
  await ownBoards({ waiting: () => (waited = true) } as Partial<Ports> as Ports);
  assert.equal(waited, false);
});

test("the first tab owns the boards at once", async () => {
  const a = open(new Device());
  await settle();
  assert.deepEqual([a.owns, a.waited], [true, false]);
});

test("a second tab waits, and owns the boards once the first closes", async () => {
  const device = new Device();
  const a = open(device);
  await settle();
  const b = open(device);
  await settle();
  assert.deepEqual([b.owns, b.waited], [false, true]);
  device.close(a.tab);
  await settle();
  assert.equal(b.owns, true);
});

test("the tab that took over keeps the boards from a third", async () => {
  const device = new Device();
  const a = open(device);
  await settle();
  const b = open(device);
  await settle();
  device.close(a.tab);
  await settle();
  const c = open(device);
  await settle();
  assert.deepEqual([b.owns, c.owns, c.waited], [true, false, true]);
});

test("a tab that asks gets the boards once the owner has saved, and the owner lets them go", async () => {
  const device = new Device();
  const a = open(device, { slow: true });
  await settle();
  const b = open(device);
  await settle();
  b.useHere();
  await settle();
  assert.deepEqual([a.events, b.owns], [[], false]);
  a.saved();
  await settle();
  assert.deepEqual([a.events, b.owns], [["saved", "handed over"], true]);
});

test("a tab that asks gets the boards ahead of one that waited longer", async () => {
  const device = new Device();
  open(device);
  await settle();
  const c = open(device);
  await settle();
  const b = open(device);
  await settle();
  b.useHere();
  await settle(), await settle(), await settle();
  assert.deepEqual([b.owns, c.owns], [true, false]);
});

test("of two tabs that ask at once, one gets the boards", async () => {
  const device = new Device();
  const a = open(device);
  await settle();
  const b = open(device);
  const c = open(device);
  await settle();
  b.useHere();
  c.useHere();
  await settle(), await settle(), await settle();
  assert.deepEqual([b.owns, c.owns, a.events], [true, false, ["saved", "handed over"]]);
});

test("the tab that handed over lets the boards go even if the asking tab closed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const device = new Device();
  const a = open(device);
  const tick = async () => {
    for (let i = 0; i < 10; i++) t.mock.timers.tick(5), await Promise.resolve();
  };
  await tick();
  const b = open(device);
  await tick();
  b.useHere();
  device.close(b.tab);
  await tick();
  assert.deepEqual(a.events, ["saved"]);
  t.mock.timers.tick(2000);
  assert.deepEqual(a.events, ["saved", "handed over"]);
});
