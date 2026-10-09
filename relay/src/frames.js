// Binary frames between devices and the relay; web/sync/frames.js and BreezyKit mirror this byte for byte.
// Device to relay: 0x00 body (to everyone else), 0x01 leb(to) body (to one). Relay to device: leb(from) body.

const MAX_LEB_BYTES = 5;

/** Unsigned LEB128, low group first. */
export function leb(n) {
  const out = [];
  while (n >= 0x80) {
    out.push((n % 0x80) | 0x80);
    n = Math.floor(n / 0x80);
  }
  out.push(n);
  return Uint8Array.from(out);
}

/** {value, next} for the LEB128 at `i`; null if truncated, over 5 bytes or above 2^32. */
export function readLeb(bytes, i) {
  let value = 0;
  for (let k = 0; k < MAX_LEB_BYTES; k++) {
    if (i + k >= bytes.length) return null;
    const b = bytes[i + k];
    value += (b & 0x7f) * 2 ** (7 * k);
    if (!(b & 0x80)) return value > 2 ** 32 ? null : { value, next: i + k + 1 };
  }
  return null;
}

/** {to, body} from a device's frame, `to` null for a broadcast; null if malformed. */
export function parseFrame(bytes) {
  if (!bytes?.length) return null;
  if (bytes[0] === 0) return { to: null, body: bytes.subarray(1) };
  if (bytes[0] !== 1) return null;
  const r = readLeb(bytes, 1);
  return r && { to: r.value, body: bytes.subarray(r.next) };
}

/** The frame a v2 device receives: leb(from) then the body. */
export function outFrame(from, body) {
  const head = leb(from);
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}
