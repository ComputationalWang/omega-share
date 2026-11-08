import { expect, test } from "bun:test";
import { deflateSync, inflateSync } from "node:zlib";
import { encodeIndexedPng } from "./png";
import { PALETTE } from "./palette";

/** The IDAT scanlines, unfiltered (None and Up only, the two the encoder writes). */
function decode(png: Uint8Array, w: number, h: number): Uint8Array {
  const buf = Buffer.from(png), parts: Buffer[] = [];
  for (let o = 8; o < buf.length; ) {
    const len = buf.readUInt32BE(o);
    if (buf.toString("ascii", o + 4, o + 8) === "IDAT") parts.push(buf.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(parts)), px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = raw[y * (w + 1)] === 2;
    for (let x = 0; x < w; x++) px[y * w + x] = ((raw[y * (w + 1) + 1 + x] ?? 0) + (up && y > 0 ? (px[(y - 1) * w + x] ?? 0) : 0)) & 255;
  }
  return px;
}

test("filter Up round-trips and None stays the default", () => {
  const w = 7, h = 5, px = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) % PALETTE.length);
  expect(decode(encodeIndexedPng(w, h, px, PALETTE, 2), w, h)).toEqual(px);
  expect(decode(encodeIndexedPng(w, h, px, PALETTE), w, h)).toEqual(px);
});

test("IDAT packs smaller than zlib level 9 (OME-2433: art headroom, same pixels)", () => {
  // A sheet-like image: a repeated 9×13 sprite on a transparent field, where a better deflate has room to win.
  const w = 256, h = 128, px = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x % 32 < 9 && y % 16 < 13) px[y * w + x] = 1 + ((x * 7 + y * 3 + ((x >> 5) ^ (y >> 4))) % 11);
  const png = encodeIndexedPng(w, h, px, PALETTE);
  expect(decode(png, w, h)).toEqual(px);
  const raw = new Uint8Array((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(px.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  const idat = Buffer.from(png).indexOf("IDAT"), len = Buffer.from(png).readUInt32BE(idat - 4);
  expect(len).toBeLessThan(deflateSync(raw, { level: 9 }).length);
});
