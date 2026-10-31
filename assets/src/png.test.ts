import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
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
