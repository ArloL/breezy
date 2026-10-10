// What relay/src/worker.js uses of the Workers runtime, for running its Durable Object in the hub. Sockets are the
// server's ends; the hub carries what they send to the devices.

export class DurableObject {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
}

/** The server's end of a socket. `out` is the hub's: (kind, payload) with kind "send" or "close". */
export class ServerSocket {
  constructor() {
    this.attachment = null;
    this.out = () => {};
    /** Closed from here: it stays among the object's until the device's close comes back. */
    this.closing = false;
  }

  send(data) {
    if (this.closing) throw new Error("closed");
    this.out("send", data);
  }

  close(code = 1000) {
    if (this.closing) return;
    this.closing = true;
    this.out("close", code);
  }

  serializeAttachment(v) {
    this.attachment = structuredClone(v);
  }

  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

export class WebSocketPair {
  constructor() {
    this[0] = { client: true };
    this[1] = new ServerSocket();
  }
}

export class WebSocketRequestResponsePair {
  constructor(request, response) {
    Object.assign(this, { request, response });
  }
}

/** Only `fetch`'s 101 answer is made, and nothing reads it. */
export class Response {
  constructor(body, init) {
    Object.assign(this, { body, ...init });
  }
}

/** A Durable Object's state: its sockets and its storage, which outlive the object. */
export class State {
  constructor(setAlarm) {
    this.sockets = [];
    this.data = new Map();
    this.alarm = null;
    this.autoResponse = null;
    const self = this;
    this.storage = {
      async get(k) {
        return structuredClone(self.data.get(k));
      },
      async put(k, v) {
        self.data.set(k, structuredClone(v));
      },
      async getAlarm() {
        return self.alarm;
      },
      async setAlarm(t) {
        self.alarm = t;
        setAlarm(t);
      },
    };
  }

  acceptWebSocket(ws) {
    this.sockets.push(ws);
  }

  getWebSockets() {
    return [...this.sockets];
  }

  setWebSocketAutoResponse(pair) {
    this.autoResponse = pair;
  }
}
