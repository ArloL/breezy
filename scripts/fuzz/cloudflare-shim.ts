// What relay/src/worker.js uses of the Workers runtime, for running its Durable Object in the hub. Sockets are the
// server's ends; the hub carries what they send to the devices.

export class DurableObject {
  ctx: unknown;
  env: unknown;

  constructor(ctx: unknown, env: unknown) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The server's end of a socket. `out` is the hub's: (kind, payload) with kind "send" or "close". */
export type Out = (...a: ["send", string | ArrayBuffer] | ["close", number]) => void;

export class ServerSocket<C = unknown> {
  attachment: unknown;
  out: Out;
  closing: boolean;
  declare conn: C;

  constructor() {
    this.attachment = null;
    this.out = () => {};
    /** Closed from here: it stays among the object's until the device's close comes back. */
    this.closing = false;
  }

  send(data: string | ArrayBuffer) {
    if (this.closing) throw new Error("closed");
    this.out("send", data);
  }

  close(code = 1000) {
    if (this.closing) return;
    this.closing = true;
    this.out("close", code);
  }

  serializeAttachment(v: unknown) {
    this.attachment = structuredClone(v);
  }

  deserializeAttachment(): unknown {
    return structuredClone(this.attachment);
  }
}

export class WebSocketPair {
  0: { client: boolean };
  1: ServerSocket;

  constructor() {
    this[0] = { client: true };
    this[1] = new ServerSocket();
  }
}

export class WebSocketRequestResponsePair {
  declare request: string;
  declare response: string;

  constructor(request: string, response: string) {
    Object.assign(this, { request, response });
  }
}

/** Only `fetch`'s 101 answer is made, and nothing reads it. */
export class Response {
  constructor(body: unknown, init: object) {
    Object.assign(this, { body, ...init });
  }
}

/** A Durable Object's state: its sockets and its storage, which outlive the object. */
export class State<C = unknown> {
  sockets: ServerSocket<C>[];
  data: Map<string, unknown>;
  alarm: number | null;
  autoResponse: WebSocketRequestResponsePair | null;
  storage: {
    get(k: string): Promise<unknown>;
    put(k: string, v: unknown): Promise<void>;
    getAlarm(): Promise<number | null>;
    setAlarm(t: number): Promise<void>;
  };

  constructor(setAlarm: (t: number) => void) {
    this.sockets = [];
    this.data = new Map();
    this.alarm = null;
    this.autoResponse = null;
    const self = this;
    this.storage = {
      async get(k: string) {
        return structuredClone(self.data.get(k));
      },
      async put(k: string, v: unknown) {
        self.data.set(k, structuredClone(v));
      },
      async getAlarm() {
        return self.alarm;
      },
      async setAlarm(t: number) {
        self.alarm = t;
        setAlarm(t);
      },
    };
  }

  acceptWebSocket(ws: ServerSocket<C>) {
    this.sockets.push(ws);
  }

  getWebSockets() {
    return [...this.sockets];
  }

  setWebSocketAutoResponse(pair: WebSocketRequestResponsePair) {
    this.autoResponse = pair;
  }
}
