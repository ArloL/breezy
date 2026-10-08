// A space's key and token, sealed records and invites, as BreezyKit's SpaceKeys and Invite.
import { encode, decode } from "./base64.js";

const enc = new TextEncoder();
export const INVITE_PREFIX = "https://arlol.github.io/breezy/#join=";
export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

export class SpaceKeys {
  static async create(space, secret) {
    const base = await crypto.subtle.importKey("raw", secret, "HKDF", false, ["deriveKey", "deriveBits"]);
    const info = (s) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(), info: enc.encode(s) });
    const key = await crypto.subtle.deriveKey(info("breezy key"), base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    const token = new Uint8Array(await crypto.subtle.deriveBits(info("breezy token"), base, 256));
    return new SpaceKeys(space, key, token);
  }

  constructor(space, key, token) {
    this.space = space;
    this.key = key;
    this.token = token;
  }

  aad(id) {
    const a = new Uint8Array(this.space.length + id.length);
    a.set(this.space);
    a.set(id, this.space.length);
    return a;
  }

  /** Nonce, ciphertext and tag; the space and record ids are bound in, so the blob opens nowhere else. */
  async seal(plain, id, nonce = randomBytes(12)) {
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: this.aad(id) }, this.key, plain));
    const out = new Uint8Array(nonce.length + ct.length);
    out.set(nonce);
    out.set(ct, nonce.length);
    return out;
  }

  async open(blob, id) {
    const iv = blob.slice(0, 12);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: this.aad(id) }, this.key, blob.slice(12)));
  }
}

/** HTTPS, or plain HTTP to this computer for trying the server out. */
export function validServer(s) {
  try {
    const u = new URL(s);
    return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1"].includes(u.hostname));
  } catch {
    return false;
  }
}

export const inviteLink = ({ server, space, secret }) => INVITE_PREFIX + encode(enc.encode(JSON.stringify({ secret, server, space })));

/** The invite in pasted text, which may hold more than the link. */
export function parseInvite(text) {
  const at = text.indexOf("#join=");
  if (at < 0) return null;
  const bytes = decode(text.slice(at + 6).match(/^[A-Za-z0-9_-]*/)[0]);
  if (!bytes) return null;
  try {
    const { server, space, secret } = JSON.parse(new TextDecoder().decode(bytes));
    if (!validServer(server) || decode(space)?.length !== 16 || decode(secret)?.length !== 32) return null;
    return { server, space, secret };
  } catch {
    return null;
  }
}
