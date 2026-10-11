// relay/src/worker.js's Durable Object, run in the hub on virtual time, one per run: the relay the devices meet.
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as V from "./virtual.ts";
import { State, type ServerSocket } from "./cloudflare-shim.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** What the hub uses of the Worker's Durable Object. */
interface Space {
  fetch(): Promise<unknown>;
  alarm(): Promise<void>;
  webSocketMessage(ws: ServerSocket, message: string | ArrayBuffer): Promise<void>;
  webSocketClose(ws: ServerSocket, code: number, reason: string, clean: boolean): Promise<void>;
}

/** A socket's state as the Worker keeps it. */
export interface Attachment {
  id: string;
  authed: boolean;
  left?: boolean;
  holds: string[];
}

/** The hub's end of a socket, which the relay's end names. */
export interface RelayConn<C> {
  server?: ServerSocket<C>;
}

/** The Worker's module with its imports pointed at the shim and at relay/src, written under build/. */
async function loadWorker(): Promise<{ Space: new (state: State<unknown>, env: object) => Space }> {
  const src = `${root}relay/src/`;
  const shim = pathToFileURL(fileURLToPath(new URL("./cloudflare-shim.ts", import.meta.url))).href;
  const text = readFileSync(`${src}worker.js`, "utf8")
    .replace(`import { DurableObject } from "cloudflare:workers";`, `import { DurableObject, Response, WebSocketPair, WebSocketRequestResponsePair } from "${shim}";`)
    .replace(/from "\.\/([a-z]+\.js)"/g, (_, f: string) => `from "${pathToFileURL(src + f).href}"`);
  mkdirSync(`${root}build/fuzz`, { recursive: true });
  const out = `${root}build/fuzz/worker.mjs`;
  // runs in parallel share the file: each writes it whole, then moves it in place
  writeFileSync(`${out}.${process.pid}`, text);
  renameSync(`${out}.${process.pid}`, out);
  return import(pathToFileURL(out).href);
}

const worker = await loadWorker();

export class Relay<C extends RelayConn<C>> {
  ctx: V.Context;
  toClient: (conn: C, data: string | ArrayBuffer) => void;
  closeClient: (conn: C, code: number) => void;
  alarmTimer: ReturnType<typeof setTimeout> | null;
  state: State<C>;
  space: Space;

  /** `toClient(conn, data)` carries a frame to a device, `closeClient(conn, code)` a close. */
  constructor(ctx: V.Context, { toClient, closeClient }: { toClient: (conn: C, data: string | ArrayBuffer) => void; closeClient: (conn: C, code: number) => void }) {
    this.ctx = ctx;
    this.toClient = toClient;
    this.closeClient = closeClient;
    this.alarmTimer = null;
    this.state = new State((t) => this.setAlarm(t));
    this.space = new worker.Space(this.state, {});
  }

  setAlarm(t: number) {
    V.run(this.ctx, () => {
      clearTimeout(this.alarmTimer ?? undefined);
      this.alarmTimer = setTimeout(() => {
        this.alarmTimer = null;
        this.state.alarm = null;
        this.space.alarm();
      }, t - Date.now());
    });
  }

  /** A device's socket reached the relay. */
  async open(conn: C) {
    await V.run(this.ctx, async () => {
      // the shim's pair hands the object its end; the device's end is the hub's `conn`
      const accept = this.state.acceptWebSocket.bind(this.state);
      this.state.acceptWebSocket = (ws: ServerSocket<C>) => {
        ws.conn = conn;
        ws.out = (kind, v) => (kind === "send" ? this.toClient(conn, v) : this.closeClient(conn, v));
        conn.server = ws;
        accept(ws);
      };
      try {
        await this.space.fetch();
      } finally {
        this.state.acceptWebSocket = accept;
      }
    });
  }

  /** A frame from a device: text, or bytes as a Uint8Array. */
  async message(conn: C, data: string | Uint8Array<ArrayBuffer>) {
    const ws = conn.server;
    if (!ws || !this.state.sockets.includes(ws)) return;
    const auto = this.state.autoResponse;
    if (typeof data === "string" && auto && data === auto.request) {
      if (!ws.closing) this.toClient(conn, auto.response);
      return;
    }
    const message = typeof data === "string" ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    await V.run(this.ctx, () => this.space.webSocketMessage(ws, message));
  }

  /** A device's close reached the relay: one it began, or its answer to the relay's. */
  async closed(conn: C) {
    const ws = conn.server;
    if (!ws || !this.state.sockets.includes(ws)) return;
    this.state.sockets.splice(this.state.sockets.indexOf(ws), 1);
    if (!ws.closing) await V.run(this.ctx, () => this.space.webSocketClose(ws, 1000, "", true));
  }

  /** A deploy: every socket drops, storage stays, and a new object takes over. */
  restart() {
    const sockets = this.state.sockets;
    this.state.sockets = [];
    for (const ws of sockets) this.closeClient(ws.conn, 1012);
    this.evict();
  }

  /** The object is evicted between messages: sockets and storage stay, memory goes. */
  evict() {
    this.space = new worker.Space(this.state, {});
  }

  /** Connection id → ids held, as the relay would announce them now. */
  holds() {
    const out: Record<string, string[]> = {};
    for (const ws of this.state.sockets) {
      const a = ws.deserializeAttachment() as Attachment | null;
      if (a?.authed && !a.left && a.holds.length) out[a.id] = a.holds;
    }
    return out;
  }
}
