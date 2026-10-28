// Sends what the app recorded (flight.ts) to its space's server, beside sync.php (server/diag.php): when its owner
// asks, and on an error or a card out of sight, each at most once in 10 minutes. See
// docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md.
import type { Recording } from "./flight.ts";
import { deflateRaw } from "./sync/engine.ts";

export type Why = "asked" | "error" | "sight";

/** A space's server, as sync.php's address, the space and its token, as the sync engine sends them. */
export interface Target {
  server: string;
  space: string;
  token: string;
}

/** The most diag.php takes, inflated. */
export const LIMIT = 512 * 1024;
const EVERY_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

export const diagUrl = (server: string) => server.replace(/sync\.php$/, "diag.php");

/** `r`'s newest entries whose body fits LIMIT, what it left out counted as dropped. */
function fitting(why: Why, r: Recording): string {
  let entries = r.entries;
  for (;;) {
    const body = JSON.stringify({ why, recording: { ...r, dropped: r.dropped + r.entries.length - entries.length, entries } });
    if (new TextEncoder().encode(body).length <= LIMIT || !entries.length) return body;
    entries = entries.slice(Math.ceil(entries.length / 10));
  }
}

/** Whether the server took `r`; a failure of any kind is false, never a throw. */
export async function send(t: Target, why: Why, r: Recording, { fetch: f = globalThis.fetch } = {}): Promise<boolean> {
  try {
    const url = new URL(diagUrl(t.server));
    url.searchParams.set("space", t.space);
    const text = fitting(why, r);
    const headers: Record<string, string> = { Authorization: `Bearer ${t.token}`, "Content-Type": "application/json" };
    const deflated = await deflateRaw(text)?.catch(() => null);
    if (deflated) headers["Content-Encoding"] = "deflate";
    const res = await f(url.href, { method: "POST", headers, body: deflated ?? text, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return res.ok;
  } catch {
    return false;
  }
}

/** Sends when asked, and on an error or a broken sight once in 10 minutes each, to whichever space `target` names. */
export class Reporter {
  private readonly last = new Map<Why, number>();
  private readonly target: () => Target | null | Promise<Target | null>;
  private readonly recording: () => Recording;
  private readonly now: () => number;
  private readonly sender: typeof send;

  constructor(target: () => Target | null | Promise<Target | null>, recording: () => Recording,
    { now = () => Date.now(), send: s = send }: { now?: () => number; send?: typeof send } = {}) {
    this.target = target;
    this.recording = recording;
    this.now = now;
    this.sender = s;
  }

  async report(why: Why): Promise<boolean> {
    const at = this.now(), last = this.last.get(why);
    if (why !== "asked" && last !== undefined && at - last < EVERY_MS) return false;
    const t = await Promise.resolve(this.target()).catch(() => null);
    if (!t) return false;
    if (why !== "asked") this.last.set(why, at);
    return this.sender(t, why, this.recording());
  }
}
