// Virtual time for the web devices and the relay, which run in the hub's process: timers, clocks and random bytes
// used under a context (a device's or the relay's) come from here, and the hub's own code keeps the real ones.
import { AsyncLocalStorage } from "node:async_hooks";
import { deflateRawSync } from "node:zlib";
import { Rng } from "./rng.ts";

const als = new AsyncLocalStorage<Context>();
const real = {
  setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout, setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval, setImmediate: globalThis.setImmediate, dateNow: Date.now,
  perfNow: performance.now.bind(performance), getRandomValues: crypto.getRandomValues.bind(crypto),
};
export { real };

/** Virtual ms since the run began. */
export let now = 0;
let seq = 0;
/** id → {id, at, ctx, fn, every} */
const timers = new Map<number, Timer>();
/** Async crypto calls not yet settled, which settling waits for. */
let pending = 0;

/** A context: `name` ("relay" or a device index) and its wall clock's skew. */
interface Timer {
  id: number;
  at: number;
  ctx: Context;
  fn: () => void;
  every: number | undefined;
}

export class Context {
  name: string | number;
  skew: number;
  frozen: boolean;
  online: boolean;
  rng: Rng;

  constructor(name: string | number, seed: number | bigint) {
    this.name = name;
    this.skew = 0;
    this.frozen = false;
    /** What `navigator.onLine` says under this context. */
    this.online = true;
    this.rng = new Rng(seed);
  }
}

export const current = () => als.getStore() ?? null;
export const run = <R>(ctx: Context, fn: () => R): R => als.run(ctx, fn);

export function setTime(t: number) {
  if (t < now) throw new Error(`time went back: ${t} < ${now}`);
  now = t;
}

function schedule(ctx: Context, fn: () => void, ms: number | undefined, every?: number) {
  const id = ++seq;
  timers.set(id, { id, at: now + Math.max(0, Number(ms) || 0), ctx, fn, every });
  return id;
}

/** The earliest timer of `ctx`, or null. */
export function next(ctx: Context) {
  let at: number | null = null;
  for (const t of timers.values()) if (t.ctx === ctx && (at === null || t.at < at)) at = t.at;
  return at;
}

/** Runs `ctx`'s timers due now, earliest first, including ones they set for no later than now. */
export function fire(ctx: Context) {
  for (;;) {
    let due: Timer | null = null;
    for (const t of timers.values()) if (t.ctx === ctx && t.at <= now && (!due || t.at < due.at || (t.at === due.at && t.id < due.id))) due = t;
    if (!due) return;
    if (due.every !== undefined) due.at = now + Math.max(1, due.every);
    else timers.delete(due.id);
    als.run(ctx, due.fn);
  }
}

/** A new run: time starts again at 0, and no timer of an earlier run is left. */
export function reset() {
  now = 0;
  timers.clear();
}

/** Forgets `ctx`'s timers, as when a device goes for good. */
export function drop(ctx: Context) {
  for (const t of [...timers.values()]) if (t.ctx === ctx) timers.delete(t.id);
}

export const busy = () => pending > 0;

let installed = false;

interface Held {
  bytes: Buffer;
}

export function install() {
  if (installed) return;
  installed = true;
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const ctx = current();
    return ctx ? schedule(ctx, () => fn(...args), ms) : real.setTimeout(fn, ms, ...args);
  }) as typeof setTimeout;
  globalThis.setInterval = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const ctx = current();
    return ctx ? schedule(ctx, () => fn(...args), ms, Number(ms) || 0) : real.setInterval(fn, ms, ...args);
  }) as typeof setInterval;
  globalThis.clearTimeout = globalThis.clearInterval = (id?: string | number | NodeJS.Timeout) => {
    if (typeof id === "number" && timers.has(id)) timers.delete(id);
    else if (id != null && typeof id !== "number") real.clearTimeout(id);
  };
  // a browser's frames, 60 a second, which the app's edge scrolling and camera ask for
  globalThis.requestAnimationFrame = (f: FrameRequestCallback) => globalThis.setTimeout(() => f(performance.now()), 16) as unknown as number;
  globalThis.cancelAnimationFrame = (id: number) => globalThis.clearTimeout(id);
  Date.now = () => {
    const ctx = current();
    return ctx ? 1_800_000_000_000 + now + ctx.skew : real.dateNow();
  };
  performance.now = () => (current() ? now : real.perfNow());
  const onLine = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(navigator), "onLine")?.get;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => current()?.online ?? onLine?.call(navigator) ?? true });
  crypto.getRandomValues = ((a: ArrayBufferView<ArrayBuffer>) => {
    const ctx = current();
    if (!ctx) return real.getRandomValues(a);
    const bytes = ctx.rng.bytes(a.byteLength);
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).set(bytes);
    return a;
  }) as typeof crypto.getRandomValues;
  // on a thread pool, calls under way finish in no fixed order: one at a time, they finish in the order they were made
  const subtle = crypto.subtle as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  let chain: Promise<unknown> = Promise.resolve();
  for (const name of ["encrypt", "decrypt", "importKey", "deriveKey", "deriveBits", "digest", "sign", "verify", "exportKey"]) {
    const f = subtle[name].bind(subtle);
    subtle[name] = (...args: unknown[]) => {
      pending++;
      const done = chain.then(() => f(...args));
      chain = done.catch(() => {});
      return done.finally(() => pending--);
    };
  }
  // a Blob's stream reads outside the event loop's turns, which settling cannot count; this one hands its bytes over
  const RealBlob = globalThis.Blob;
  globalThis.Blob = class extends RealBlob {
    constructor(parts: BlobPart[] = [], options?: BlobPropertyBag) {
      super(parts, options);
      (this as unknown as Held).bytes = Buffer.concat(parts.map((p) => (typeof p === "string" ? Buffer.from(p) : ArrayBuffer.isView(p) ? Buffer.from(new Uint8Array(p.buffer, p.byteOffset, p.byteLength)) : Buffer.from(p as ArrayBuffer))));
    }

    override stream() {
      const bytes = new Uint8Array((this as unknown as Held).bytes);
      return new ReadableStream<Uint8Array<ArrayBuffer>>({ start: (c) => (c.enqueue(bytes), c.close()) });
    }
  };
  // zlib's own streams run on a thread pool, which settling cannot see; this one deflates in place when the input ends
  globalThis.CompressionStream = class {
    declare readable: ReadableStream<Uint8Array<ArrayBuffer>>;
    declare writable: WritableStream<BufferSource>;

    constructor(format: CompressionFormat) {
      if (format !== "deflate-raw") throw new TypeError(format);
      const chunks: Buffer[] = [];
      const t = new TransformStream<BufferSource, Uint8Array<ArrayBuffer>>({
        transform: (c) => {
          chunks.push(Buffer.from(c as Uint8Array));
        },
        flush: (out) => out.enqueue(new Uint8Array(deflateRawSync(Buffer.concat(chunks)))),
      });
      [this.readable, this.writable] = [t.readable, t.writable];
    }
  };
}

/** Turns of the event loop until no crypto call is pending and `quiet()` held for a few rounds running. */
export async function settle(quiet = () => true, limit = 200_000) {
  let calm = 0;
  for (let i = 0; i < limit; i++) {
    await new Promise((r) => real.setImmediate(r));
    calm = !busy() && quiet() ? calm + 1 : 0;
    if (calm >= 3) return;
  }
  throw new Error("did not settle");
}
