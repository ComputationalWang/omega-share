// "Watching" poses (OME-1640): seated from behind, plus a laugh shake and a gasp lean, on their own lazy sheet.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { gzipSync, inflateSync } from "node:zlib";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const read = (f: string): Buffer => readFileSync(join(ROOT, f));
interface Rect { x: number; y: number; w: number; h: number }
interface Atlas {
  frames: Record<string, { frame: Rect; anchor: { x: number; y: number } }>;
  animations: Record<string, string[]>;
  meta: { image: string; omega: { states: { id: string; frames: number }[]; anims: Record<string, { frames: string[]; ms: number[]; loop: boolean }> } };
}
const atlas = JSON.parse(read("avatars/watching.json").toString("utf8")) as Atlas;
const AVATARS = ["juno", "pip", "mo", "kiki"];
const DIRS = ["ne", "nw"];
const STATES: [string, number][] = [["base", 1], ["laugh", 2], ["gasp", 2]];

test("every avatar has base, laugh (2) and gasp (2) seated from behind, ne and nw", () => {
  expect(atlas.meta.image).toBe("watching.png");
  expect(atlas.meta.omega.states).toEqual(STATES.map(([id, frames]) => ({ id, frames })));
  const want = AVATARS.flatMap((a) => DIRS.flatMap((d) => STATES.flatMap(([s, n]) => Array.from({ length: n }, (_, i) => `watch/${s}/${a}/${d}/${String(i)}`))));
  expect(Object.keys(atlas.frames).sort()).toEqual(want.sort());
  for (const f of Object.values(atlas.frames)) {
    expect([f.frame.w, f.frame.h]).toEqual([32, 64]);
    expect(f.anchor).toEqual({ x: 0.5, y: 61 / 64 });
  }
  for (const a of AVATARS) for (const d of DIRS) {
    expect(atlas.meta.omega.anims[`watch/laugh/${a}/${d}`]?.loop).toBe(false);
    expect(atlas.meta.omega.anims[`watch/gasp/${a}/${d}`]?.loop).toBe(false);
  }
});

const png = read("avatars/watching.png");
// Our encoder writes one IDAT with filter 0 on every row, so decoding is inflate + drop the filter bytes.
const img = ((): { w: number; data: Uint8Array } => {
  const w = png.readUInt32BE(16), h = png.readUInt32BE(20);
  let o = 8, idat = Buffer.alloc(0);
  while (o < png.length) {
    const len = png.readUInt32BE(o), type = png.toString("latin1", o + 4, o + 8);
    if (type === "IDAT") idat = Buffer.concat([idat, png.subarray(o + 8, o + 8 + len)]);
    o += 12 + len;
  }
  const raw = inflateSync(idat), data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) data.set(raw.subarray(y * (w + 1) + 1, (y + 1) * (w + 1)), y * w);
  return { w, data };
})();
const pixels = (r: Rect): string => {
  let s = "";
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) s += String.fromCharCode(img.data[y * img.w + x] ?? 0);
  return s;
};

test("every frame is its own picture: no reaction repeats the base or another frame", () => {
  for (const a of AVATARS) for (const d of DIRS) {
    const own = Object.entries(atlas.frames).filter(([k]) => k.includes(`/${a}/${d}/`)).map(([, f]) => pixels(f.frame));
    expect(new Set(own).size).toBe(own.length);
  }
});

test("the 4 avatars stay distinct from behind: every pair differs in ≥ 25% of its base pixels", () => {
  const base = AVATARS.map((a) => pixels(atlas.frames[`watch/base/${a}/ne/0`]?.frame ?? { x: 0, y: 0, w: 0, h: 0 }));
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const p = base[i] ?? "", q = base[j] ?? "";
    let diff = 0, ink = 0;
    for (let k = 0; k < p.length; k++) {
      if (p.charCodeAt(k) || q.charCodeAt(k)) ink++;
      if (p[k] !== q[k]) diff++;
    }
    expect(diff / ink).toBeGreaterThanOrEqual(0.25);
  }
});

test("lazy PNG-8 at most 512×256, sheet + gz json ≤ 12 KB", () => {
  expect([png[24], png[25]]).toEqual([8, 3]);
  expect(png.readUInt32BE(16)).toBeLessThanOrEqual(512);
  expect(png.readUInt32BE(20)).toBeLessThanOrEqual(256);
  expect(png.length + gzipSync(read("avatars/watching.json")).length).toBeLessThanOrEqual(12 * 1024);
});

test("hair colours and shirt tints swap on the watching sheet too", () => {
  for (const f of ["avatars/hairs.json", "avatars/tints.json"]) {
    expect((JSON.parse(read(f).toString("utf8")) as { sheets: string[] }).sheets).toContain("watching.png");
  }
});
