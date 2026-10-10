// The live layer's relay: one Durable Object per space forwards sealed messages between that space's connections and
// keeps who holds what. It stores the space token's hash and nothing else; see the multiplayer design.
import { DurableObject } from "cloudflare:workers";
import { outFrame, parseFrame } from "./frames.js";
import { conflicts, holdsOf, lapsed, refusal, unauthenticated, MAX_MESSAGE } from "./holds.js";

const SPACE = /^[A-Za-z0-9_-]{22}$/;
const TICK_MS = 5_000;

const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64 = (u) => btoa(Array.from({ length: Math.ceil(u.length / 8192) }, (_, i) => String.fromCharCode(...u.subarray(i * 8192, (i + 1) * 8192))).join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** SHA-256 of the token's 32 bytes, as sync.php keeps it; null for anything else. */
async function digest(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return toB64(new Uint8Array(await crypto.subtle.digest("SHA-256", fromB64(token))));
}

function send(ws, text) {
  try {
    ws.send(text);
  } catch {}
}

export class Space extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // the apps' liveness check, answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async fetch() {
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    const now = Date.now();
    const n = ((await this.ctx.storage.get("next")) ?? 0) + 1;
    await this.ctx.storage.put("next", n);
    server.serializeAttachment({ id: String(n), authed: false, opened: now, last: now, holds: [] });
    await this.wake();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Every socket with its connection, which survives hibernation as the socket's attachment. */
  conns() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, ...ws.deserializeAttachment() }));
  }

  async webSocketMessage(ws, message) {
    if ((typeof message === "string" ? message.length : message.byteLength) > MAX_MESSAGE) return;
    const binary = typeof message !== "string";
    let m;
    try {
      m = binary ? null : JSON.parse(message);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();
    me.last = Date.now();
    if (!me.authed) {
      if (binary) return ws.close(4001, "unauthorized");
      if (m?.t !== "auth" || !(await this.authorised(m.token))) return ws.close(4001, "unauthorized");
      me.authed = true;
      me.v = m.v === 2 ? 2 : 1;
      ws.serializeAttachment(me);
      // a device back after its network changed names the connection it had, which may not have closed: it goes now,
      // with its holds, rather than when it lapses, so that the device can hold them again and nobody sees it twice
      const old = typeof m.replaces === "string" && this.conns().find((c) => c.authed && c.id === m.replaces && c.id !== me.id);
      if (old) this.leave(old.ws);
      const others = this.conns().filter((c) => c.authed && c.id !== me.id);
      send(ws, JSON.stringify({ t: "welcome", id: me.id, peers: others.map((c) => c.id), holds: holdsOf(others) }));
      for (const c of others) send(c.ws, JSON.stringify({ t: "join", id: me.id }));
      return;
    }
    if (binary) {
      ws.serializeAttachment(me);
      const frame = parseFrame(new Uint8Array(message));
      return frame && this.forward(me, { bytes: frame.body }, frame.to === null ? null : String(frame.to));
    }
    if (m?.t === "hold") {
      const bad = refusal(me.holds, m.ids);
      const refused = bad ?? conflicts(this.conns().filter((c) => c.authed), me.id, m.ids);
      if (!bad && !refused.length) me.holds = [...new Set([...me.holds, ...m.ids])];
      ws.serializeAttachment(me);
      if (bad || refused.length) return send(ws, JSON.stringify({ t: "refused", ids: refused }));
      await this.wake();
      return this.announce();
    }
    if (m?.t === "release") {
      const had = me.holds.length;
      me.holds = [];
      ws.serializeAttachment(me);
      if (had) this.announce();
      return;
    }
    ws.serializeAttachment(me);
    if (typeof m?.body !== "string") return;
    this.forward(me, { text: m.body }, m.to || null);
  }

  /** Sends a body ({bytes} or {text}, base64url) from `me` to `to`, or to everyone else: binary to v2 devices, JSON to older ones. */
  forward(me, body, to) {
    let binary, json;
    for (const c of this.conns()) {
      if (!c.authed || c.id === me.id || (to !== null && c.id !== to)) continue;
      if (c.v === 2) {
        try {
          binary ??= outFrame(Number(me.id), (body.bytes ??= fromB64(body.text)));
        } catch {
          continue;
        }
        send(c.ws, binary);
      } else {
        json ??= JSON.stringify({ from: me.id, body: (body.text ??= toB64(body.bytes)) });
        send(c.ws, json);
      }
    }
  }

  async webSocketClose(ws) {
    this.leave(ws);
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const me = ws.deserializeAttachment();
    // a socket closed from here stays among the object's until its far end answers, which a dead one never does
    try {
      ws.serializeAttachment({ ...me, authed: false, holds: [] });
    } catch {}
    try {
      ws.close(1000);
    } catch {}
    if (!me?.authed) return;
    for (const c of this.conns()) if (c.ws !== ws && c.authed) send(c.ws, JSON.stringify({ t: "leave", id: me.id }));
    if (me.holds.length) this.announce(ws);
  }

  /** Tells every connection who holds what, leaving out `closing`. */
  announce(closing) {
    const live = this.conns().filter((c) => c.authed && c.ws !== closing);
    const text = JSON.stringify({ t: "holds", holds: holdsOf(live) });
    for (const c of live) send(c.ws, text);
  }

  /** The first token sets the space's; later ones must match. */
  async authorised(token) {
    const hash = await digest(token);
    if (!hash) return false;
    const stored = await this.ctx.storage.get("token");
    if (stored === undefined) {
      await this.ctx.storage.put("token", hash);
      return true;
    }
    return stored === hash;
  }

  /** An alarm soon, if none is set, to close silent sockets and lapse silent holds. */
  async wake() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + TICK_MS);
  }

  async alarm() {
    const now = Date.now();
    const conns = this.conns();
    for (const c of unauthenticated(conns, now)) {
      try {
        c.ws.close(4001, "unauthorized");
      } catch {}
    }
    const gone = lapsed(conns.filter((c) => c.authed), now);
    for (const c of gone) c.ws.serializeAttachment({ ...c.ws.deserializeAttachment(), holds: [] });
    if (gone.length) this.announce();
    if (this.conns().some((c) => !c.authed || c.holds.length)) await this.ctx.storage.setAlarm(now + TICK_MS);
  }
}

export default {
  async fetch(request, env) {
    const space = new URL(request.url).searchParams.get("space") ?? "";
    if (!SPACE.test(space)) return new Response("space", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("websocket only", { status: 426 });
    return env.SPACE.get(env.SPACE.idFromName(space)).fetch(request);
  },
};
