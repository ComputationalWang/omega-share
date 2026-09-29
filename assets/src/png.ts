// Minimal indexed-colour PNG encoder (colour type 3 + tRNS). No dependencies.
import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = (CRC_TABLE[(c ^ b) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Encode an indexed image. `pixels[i]` indexes `palette`; index 0 should be transparent. */
export function encodeIndexedPng(width: number, height: number, pixels: Uint8Array, palette: readonly RGBA[]): Uint8Array {
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 3; // indexed
  const plte = new Uint8Array(palette.length * 3);
  const trns = new Uint8Array(palette.length);
  palette.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    trns[i] = c.a;
  });
  // tRNS may stop after the last non-opaque entry.
  let lastAlpha = 0;
  trns.forEach((a, i) => {
    if (a !== 255) lastAlpha = i + 1;
  });
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none (best for flat pixel art)
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk("IHDR", ihdr), chunk("PLTE", plte)];
  if (lastAlpha > 0) parts.push(chunk("tRNS", trns.subarray(0, lastAlpha)));
  parts.push(chunk("IDAT", idat), chunk("IEND", new Uint8Array(0)));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Animated PNG (APNG) of equal-size indexed frames, looping forever. Preview use only. */
export function encodeIndexedApng(width: number, height: number, frames: readonly Uint8Array[], delaysMs: readonly number[], palette: readonly RGBA[]): Uint8Array {
  const still = encodeIndexedPng(width, height, frames[0] ?? new Uint8Array(width * height), palette);
  // Reuse the still's IHDR/PLTE/tRNS: walk its chunks and keep everything before IDAT.
  const head: Uint8Array[] = [still.subarray(0, 8)];
  const sv = new DataView(still.buffer, still.byteOffset, still.byteLength);
  for (let o = 8; o < still.length; ) {
    const len = sv.getUint32(o);
    const type = String.fromCharCode(...still.subarray(o + 4, o + 8));
    if (type === "IDAT" || type === "IEND") break;
    head.push(still.subarray(o, o + 12 + len));
    if (type === "IHDR") {
      const actl = new Uint8Array(8);
      new DataView(actl.buffer).setUint32(0, frames.length);
      head.push(chunk("acTL", actl));
    }
    o += 12 + len;
  }
  const parts = [...head];
  let seq = 0;
  frames.forEach((px, i) => {
    const fctl = new Uint8Array(26);
    const f = new DataView(fctl.buffer);
    f.setUint32(0, seq++);
    f.setUint32(4, width);
    f.setUint32(8, height);
    f.setUint16(20, delaysMs[i] ?? 100);
    f.setUint16(22, 1000);
    parts.push(chunk("fcTL", fctl));
    const raw = new Uint8Array((width + 1) * height);
    for (let y = 0; y < height; y++) raw.set(px.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
    const data = deflateSync(raw, { level: 9 });
    if (i === 0) parts.push(chunk("IDAT", data));
    else {
      const fd = new Uint8Array(4 + data.length);
      new DataView(fd.buffer).setUint32(0, seq++);
      fd.set(data, 4);
      parts.push(chunk("fdAT", fd));
    }
  });
  parts.push(chunk("IEND", new Uint8Array(0)));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
