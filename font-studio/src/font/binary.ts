// Big-endian binary reading/writing for OpenType data.

export class Reader {
  data: Uint8Array;
  view: DataView;
  pos: number;
  constructor(data: Uint8Array, pos = 0) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.pos = pos;
  }
  seek(pos: number) { this.pos = pos; return this; }
  u8() { return this.view.getUint8(this.pos++); }
  i8() { return this.view.getInt8(this.pos++); }
  u16() { const v = this.view.getUint16(this.pos); this.pos += 2; return v; }
  i16() { const v = this.view.getInt16(this.pos); this.pos += 2; return v; }
  u24() { const v = (this.view.getUint16(this.pos) << 8) | this.view.getUint8(this.pos + 2); this.pos += 3; return v; }
  u32() { const v = this.view.getUint32(this.pos); this.pos += 4; return v; }
  i32() { const v = this.view.getInt32(this.pos); this.pos += 4; return v; }
  fixed() { return this.i32() / 65536; }
  f2dot14() { return this.i16() / 16384; }
  tag() { let s = ''; for (let i = 0; i < 4; i++) s += String.fromCharCode(this.u8()); return s; }
  bytes(n: number) { const b = this.data.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  // random access
  u16At(p: number) { return this.view.getUint16(p); }
  i16At(p: number) { return this.view.getInt16(p); }
  u32At(p: number) { return this.view.getUint32(p); }
}

export class Writer {
  buf: Uint8Array;
  view: DataView;
  length = 0;
  constructor(size = 1024) {
    this.buf = new Uint8Array(size);
    this.view = new DataView(this.buf.buffer);
  }
  private ensure(n: number) {
    if (this.length + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.length + n) size *= 2;
    const nb = new Uint8Array(size);
    nb.set(this.buf.subarray(0, this.length));
    this.buf = nb;
    this.view = new DataView(nb.buffer);
  }
  u8(v: number) { this.ensure(1); this.view.setUint8(this.length, v); this.length += 1; return this; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.length, v); this.length += 1; return this; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.length, v); this.length += 2; return this; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.length, clampI16(v)); this.length += 2; return this; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.length, v >>> 0); this.length += 4; return this; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.length, v); this.length += 4; return this; }
  fixed(v: number) { return this.i32(Math.round(v * 65536)); }
  f2dot14(v: number) { return this.i16(Math.round(v * 16384)); }
  tag(s: string) { for (let i = 0; i < 4; i++) this.u8(i < s.length ? s.charCodeAt(i) : 32); return this; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.buf.set(b, this.length); this.length += b.length; return this; }
  pad(align = 4) { while (this.length % align) this.u8(0); return this; }
  setU16(pos: number, v: number) { this.view.setUint16(pos, v); }
  setU32(pos: number, v: number) { this.view.setUint32(pos, v >>> 0); }
  done() { return this.buf.slice(0, this.length); }
}

export function clampI16(v: number) {
  v = Math.round(v);
  return v < -32768 ? -32768 : v > 32767 ? 32767 : v;
}

export function checksum(data: Uint8Array) {
  let sum = 0;
  const n = data.length;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const full = n - (n % 4);
  for (let i = 0; i < full; i += 4) sum = (sum + view.getUint32(i)) >>> 0;
  if (n % 4) {
    let last = 0;
    for (let i = full; i < n; i++) last |= data[i] << (24 - 8 * (i - full));
    sum = (sum + (last >>> 0)) >>> 0;
  }
  return sum >>> 0;
}
