import { test } from "node:test";
import assert from "node:assert/strict";
import { ownBoards } from "../owner.js";

/** Web Locks shared by a device's tabs, as `navigator.locks` behaves; `close` ends a tab and frees what it held. */
class Device {
  constructor() {
    this.held = new Map();
    this.queue = [];
  }

  tab() {
    const tab = {};
    tab.locks = {
      request: (name, options, cb) => {
        if (typeof options === "function") [cb, options] = [options, {}];
        return new Promise((resolve) => {
          const want = { tab, name, cb, resolve };
          if (!this.held.has(name)) return this.grant(want);
          if (options.ifAvailable) return resolve(cb(null));
          this.queue.push(want);
        });
      },
    };
    return tab;
  }

  grant(want) {
    this.held.set(want.name, want.tab);
    Promise.resolve(want.cb({ name: want.name })).then((r) => {
      this.release(want.name);
      want.resolve(r);
    });
  }

  release(name) {
    this.held.delete(name);
    const next = this.queue.findIndex((w) => w.name === name);
    if (next >= 0) this.grant(...this.queue.splice(next, 1));
  }

  close(tab) {
    this.queue = this.queue.filter((w) => w.tab !== tab);
    for (const [name, t] of this.held) if (t === tab) this.release(name);
  }
}

const settle = () => new Promise((r) => setTimeout(r, 0));

/** Opens a tab: whether it owns the boards so far, and whether it was told to wait. */
function open(device) {
  const tab = device.tab();
  const seen = { tab, owns: false, waited: false };
  ownBoards(tab.locks, () => (seen.waited = true)).then(() => (seen.owns = true));
  return seen;
}

test("without Web Locks, every tab owns the boards", async () => {
  let waited = false;
  await ownBoards(undefined, () => (waited = true));
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
