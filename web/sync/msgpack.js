// A MessagePack subset: nil, bool, int, float32/64, str, bin, array, map.

/** Marks a number to pack as float32. */
export class Float32 {
  constructor(v) {
    this.v = v;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

class Writer {
  constructor() {
    this.bytes = new Uint8Array(256);
    this.view = new DataView(this.bytes.buffer);
    this.n = 0;
  }
  room(k) {
    if (this.n + k <= this.bytes.length) return;
    const next = new Uint8Array(Math.max(this.bytes.length * 2, this.n + k));
    next.set(this.bytes.subarray(0, this.n));
    this.bytes = next;
    this.view = new DataView(next.buffer);
  }
  u8(b) {
    this.room(1);
    this.bytes[this.n++] = b;
  }
  put(tag, size, set, v) {
    this.room(1 + size);
    this.bytes[this.n++] = tag;
    set.call(this.view, this.n, v);
    this.n += size;
  }
  raw(b) {
    this.room(b.length);
    this.bytes.set(b, this.n);
    this.n += b.length;
  }
}

function header(w, n, fix, fixMax, tags) {
  if (n <= fixMax) w.u8(fix | n);
  else if (tags[0] !== null && n < 0x100) w.put(tags[0], 1, DataView.prototype.setUint8, n);
  else if (n < 0x10000) w.put(tags[1], 2, DataView.prototype.setUint16, n);
  else if (n < 0x100000000) w.put(tags[2], 4, DataView.prototype.setUint32, n);
  else throw new RangeError("msgpack: too long");
}

function int(w, v) {
  if (v >= 0) {
    if (v < 0x80) w.u8(v);
    else if (v < 0x100) w.put(0xcc, 1, DataView.prototype.setUint8, v);
    else if (v < 0x10000) w.put(0xcd, 2, DataView.prototype.setUint16, v);
    else if (v < 0x100000000) w.put(0xce, 4, DataView.prototype.setUint32, v);
    else w.put(0xcf, 8, DataView.prototype.setBigUint64, BigInt(v));
  } else if (v >= -32) w.u8(0x100 + v);
  else if (v >= -0x80) w.put(0xd0, 1, DataView.prototype.setInt8, v);
  else if (v >= -0x8000) w.put(0xd1, 2, DataView.prototype.setInt16, v);
  else if (v >= -0x80000000) w.put(0xd2, 4, DataView.prototype.setInt32, v);
  else w.put(0xd3, 8, DataView.prototype.setBigInt64, BigInt(v));
}

function write(w, v) {
  if (v === null) w.u8(0xc0);
  else if (v === true) w.u8(0xc3);
  else if (v === false) w.u8(0xc2);
  else if (typeof v === "number") {
    if (!Number.isInteger(v)) w.put(0xcb, 8, DataView.prototype.setFloat64, v);
    else if (Number.isSafeInteger(v)) int(w, v);
    else throw new RangeError("msgpack: integer outside the safe range");
  } else if (v instanceof Float32) w.put(0xca, 4, DataView.prototype.setFloat32, v.v);
  else if (typeof v === "string") {
    const b = encoder.encode(v);
    header(w, b.length, 0xa0, 31, [0xd9, 0xda, 0xdb]);
    w.raw(b);
  } else if (v instanceof Uint8Array) {
    header(w, v.length, 0, -1, [0xc4, 0xc5, 0xc6]);
    w.raw(v);
  } else if (Array.isArray(v)) {
    header(w, v.length, 0x90, 15, [null, 0xdc, 0xdd]);
    for (const x of v) write(w, x);
  } else if (v instanceof Map) {
    header(w, v.size, 0x80, 15, [null, 0xde, 0xdf]);
    for (const [k, x] of v) {
      write(w, k);
      write(w, x);
    }
  } else throw new TypeError("msgpack: unsupported value");
}

export function pack(value) {
  const w = new Writer();
  write(w, value);
  return w.bytes.slice(0, w.n);
}

class Reader {
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.n = 0;
  }
  take(k) {
    if (this.n + k > this.bytes.length) throw new RangeError("msgpack: truncated");
    const at = this.n;
    this.n += k;
    return at;
  }
  num(size, get) {
    return get.call(this.view, this.take(size));
  }
  big(get) {
    const v = get.call(this.view, this.take(8));
    if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < BigInt(Number.MIN_SAFE_INTEGER)) throw new RangeError("msgpack: integer outside the safe range");
    return Number(v);
  }
  raw(k) {
    const at = this.take(k);
    return this.bytes.slice(at, at + k);
  }
  str(k) {
    const at = this.take(k);
    return decoder.decode(this.bytes.subarray(at, at + k));
  }
  list(k) {
    const out = [];
    for (let i = 0; i < k; i++) out.push(read(this));
    return out;
  }
  map(k) {
    const out = new Map();
    for (let i = 0; i < k; i++) {
      const key = read(this);
      out.set(key, read(this));
    }
    return out;
  }
}

const U8 = DataView.prototype.getUint8;
const U16 = DataView.prototype.getUint16;
const U32 = DataView.prototype.getUint32;

function read(r) {
  const t = r.num(1, U8);
  if (t < 0x80) return t;
  if (t >= 0xe0) return t - 0x100;
  if (t <= 0x8f) return r.map(t & 15);
  if (t <= 0x9f) return r.list(t & 15);
  if (t <= 0xbf) return r.str(t & 31);
  switch (t) {
    case 0xc0: return null;
    case 0xc2: return false;
    case 0xc3: return true;
    case 0xc4: return r.raw(r.num(1, U8));
    case 0xc5: return r.raw(r.num(2, U16));
    case 0xc6: return r.raw(r.num(4, U32));
    case 0xca: return r.num(4, DataView.prototype.getFloat32);
    case 0xcb: return r.num(8, DataView.prototype.getFloat64);
    case 0xcc: return r.num(1, U8);
    case 0xcd: return r.num(2, U16);
    case 0xce: return r.num(4, U32);
    case 0xcf: return r.big(DataView.prototype.getBigUint64);
    case 0xd0: return r.num(1, DataView.prototype.getInt8);
    case 0xd1: return r.num(2, DataView.prototype.getInt16);
    case 0xd2: return r.num(4, DataView.prototype.getInt32);
    case 0xd3: return r.big(DataView.prototype.getBigInt64);
    case 0xd9: return r.str(r.num(1, U8));
    case 0xda: return r.str(r.num(2, U16));
    case 0xdb: return r.str(r.num(4, U32));
    case 0xdc: return r.list(r.num(2, U16));
    case 0xdd: return r.list(r.num(4, U32));
    case 0xde: return r.map(r.num(2, U16));
    case 0xdf: return r.map(r.num(4, U32));
    default: throw new RangeError(`msgpack: unsupported type 0x${t.toString(16)}`);
  }
}

export function unpack(bytes) {
  const r = new Reader(bytes);
  const v = read(r);
  if (r.n !== bytes.length) throw new RangeError("msgpack: trailing bytes");
  return v;
}
