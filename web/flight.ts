// What the app saw, decided and drew, kept wherever it runs so that a bug is debugged from what happened rather than
// from what the code says could: docs/superpowers/specs/2026-10-28-breezy-facts-first-design.md. Ids, numbers and
// names of things the app does, never a card's words.

export type Kind = "context" | "geometry" | "decision" | "transition" | "input" | "sync" | "life" | "timing" | "error";
export type Value = number | boolean | string | null | Value[] | { [k: string]: Value };
export type Entry = [t: number, kind: Kind, what: string, data?: { [k: string]: Value }];

/** The last seconds of frames, as `fields` names them once and `rows` give them, one a frame: what showed, what moved it
 * and what drew it (scripts/frames/fields.json), for the rules over frames in scripts/frames/rules.ts. */
export interface FrameTrack {
  fields: string[];
  rows: (number | null)[][];
}

/** A device's entries, `t` ms after `origin` on the wall clock. */
export interface Recording {
  schema: 1;
  origin: number;
  /** How many older entries the ring let go. */
  dropped: number;
  /** Which device and build, kept apart from the ring, which a long session overwrites. */
  context: { [k: string]: Value } | null;
  entries: Entry[];
  frames?: FrameTrack;
}

const tenth = (n: number) => Math.round(n * 10) / 10;

/** A rect as [x, y, w, h] to a tenth. */
export const box = (r: { x: number; y: number; w: number; h: number } | null | undefined): Value =>
  r ? [tenth(r.x), tenth(r.y), tenth(r.w), tenth(r.h)] : null;

/** A text's length and FNV-1a hash: an error's message can quote a card, and its hash still tells two apart. */
function digest(s: string) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return `${s.length}:${(h >>> 0).toString(16)}`;
}

/** An error as a hash of its message and the file and line it was thrown at; its stack's first line is its message. */
export const thrown = (e: unknown): { message: string; where: string | null } => ({
  message: digest(String((e as Error)?.message ?? e)),
  where: /([\w.-]+\.[jt]s:\d+)/.exec(String((e as Error)?.stack ?? "").split("\n").slice(1).join("\n"))?.[1] ?? null,
});

/** Whether a page turned recording off, for what recording costs to be measured against it (scripts/launch.ts). */
export const recordingOff = () => !!(globalThis as { __breezyNoFlight?: boolean }).__breezyNoFlight;

export class Flight {
  /** What a frame holds, in order, as scripts/frames/fields.json lists them: every platform's, then the web's. */
  static readonly frameFields: readonly string[] = [
    "t", "zoom", "camX", "camY", "viewW", "viewH", "boardX", "boardY", "boardW", "boardH", "px", "py", "f1x", "f1y", "f2x", "f2y",
    "wheelDX", "wheelDY", "wheelPhase", "momentumPhase", "magnify", "gesture", "coverTop", "grid",
  ];
  private readonly now: () => number;
  private readonly ring: Entry[] = [];
  private readonly size: number;
  private readonly origin: number;
  private readonly frameMs: number;
  private next = 0;
  private dropped = 0;
  private about: { [k: string]: Value } | null = null;
  private frameRows: (number | null)[][] = [];
  private frameHead = 0;

  constructor({ now = () => performance.now(), wall = () => Date.now(), size = 4000, frameMs = 30_000 }:
    { now?: () => number; wall?: () => number; size?: number; frameMs?: number } = {}) {
    this.now = now;
    this.size = size;
    this.frameMs = frameMs;
    this.origin = wall() - now();
  }

  /** Keeps a frame of every field after `t`, which it stamps on the entries' clock; frames older than `frameMs` go. A
   * frame of another length is not kept. */
  frame(values: (number | null)[]) {
    if (recordingOff() || values.length !== Flight.frameFields.length - 1) return;
    const t = tenth(this.now());
    this.frameRows.push([t, ...values]);
    while (this.frameHead < this.frameRows.length && this.frameRows[this.frameHead]![0]! < t - this.frameMs) this.frameHead++;
    // compacts now and then, rather than shifting the array on every frame
    if (this.frameHead > 4096) {
      this.frameRows = this.frameRows.slice(this.frameHead);
      this.frameHead = 0;
    }
  }

  /** Keeps `data` as it is now; whatever cannot be read is noted as such, as a note must never break the app. */
  note(kind: Kind, what: string, data?: { [k: string]: Value }) {
    // a page measured against itself without recording, for what recording costs (scripts/launch.ts)
    if (recordingOff()) return;
    let kept: { [k: string]: Value } | undefined;
    try {
      kept = data && JSON.parse(JSON.stringify(data));
    } catch {
      kept = { unreadable: true };
    }
    const e: Entry = kept ? [tenth(this.now()), kind, what, kept] : [tenth(this.now()), kind, what];
    if (this.ring.length < this.size) this.ring.push(e);
    else {
      this.ring[this.next] = e;
      this.dropped++;
    }
    this.next = (this.next + 1) % this.size;
  }

  context(data: { [k: string]: Value }) {
    this.about = data;
  }

  recording(): Recording {
    const entries = this.ring.length < this.size ? [...this.ring] : [...this.ring.slice(this.next), ...this.ring.slice(0, this.next)];
    const rows = this.frameRows.slice(this.frameHead);
    const frames = rows.length ? { frames: { fields: [...Flight.frameFields], rows } } : {};
    return { schema: 1, origin: this.origin, dropped: this.dropped, context: this.about, entries, ...frames };
  }
}
