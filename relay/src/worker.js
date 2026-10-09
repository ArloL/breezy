// The live layer's relay: one Durable Object per space forwards sealed messages between that space's connections and
// keeps who holds what. It stores the space token's hash and nothing else; see the multiplayer design.
import { DurableObject } from "cloudflare:workers";
import { conflicts, holdsOf, lapsed, refusal, unauthenticated, MAX_MESSAGE } from "./holds.js";

const SPACE = /^[A-Za-z0-9_-]{22}$/;
const TICK_MS = 5_000;

const fromB64 = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const toB64 = (u) => btoa(String.fromCharCode(...u)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

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
    server.serializeAttachment({ id: crypto.randomUUID(), authed: false, opened: now, last: now, holds: [] });
    await this.wake();
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Every socket with its connection, which survives hibernation as the socket's attachment. */
  conns() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, ...ws.deserializeAttachment() }));
  }

  async webSocketMessage(ws, message) {
    if ((typeof message === "string" ? message.length : message.byteLength) > MAX_MESSAGE) return;
    let m;
    try {
      m = JSON.parse(message);
    } catch {
      return;
    }
    const me = ws.deserializeAttachment();
    me.last = Date.now();
    if (!me.authed) {
      if (m?.t !== "auth" || !(await this.authorised(m.token))) return ws.close(4001, "unauthorized");
      me.authed = true;
      ws.serializeAttachment(me);
      const others = this.conns().filter((c) => c.authed && c.id !== me.id);
      send(ws, JSON.stringify({ t: "welcome", id: me.id, peers: others.map((c) => c.id), holds: holdsOf(others) }));
      for (const c of others) send(c.ws, JSON.stringify({ t: "join", id: me.id }));
      return;
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
    const out = JSON.stringify({ from: me.id, body: m.body });
    for (const c of this.conns()) if (c.authed && c.id !== me.id && (!m.to || c.id === m.to)) send(c.ws, out);
  }

  async webSocketClose(ws) {
    this.leave(ws);
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const me = ws.deserializeAttachment();
    if (me?.holds.length) {
      try {
        ws.serializeAttachment({ ...me, holds: [] });
      } catch {}
    }
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
