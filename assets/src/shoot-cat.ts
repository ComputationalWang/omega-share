// OME-1519 preview: the cat's walk and sit next to its loaf, on a floor tile. `bun assets/src/shoot-cat.ts` writes
// preview/cat-walk@4x.png (rows = colour × facing; columns = loaf, walk 0–3, sit, empty bed; 1× strip on top) and one live-speed
// preview/cat-walk-<colour>-<dir>@4x.apng per row.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PIECES, pieceFrames } from "./furniture";
import { PALETTE, colorIndex } from "./palette";
import { encodeIndexedApng, encodeIndexedPng } from "./png";
import { upscale } from "./sprite";

const OUT = join(import.meta.dir, "..", "preview");
const cat = PIECES.find((p) => p.id === "cat");
if (!cat?.walk) throw new Error("no walking cat");
const CELL = { w: 44, h: 44, ax: 22, ay: 34 };
const floor = colorIndex("floor", 1), seam = colorIndex("floor", 2);

/** A floor cell with a 2:1 tile outline round the anchor, the frame's anchor on its centre. */
function cell(f: { w: number; h: number; ax: number; ay: number; img: Uint8Array }): Uint8Array {
  const out = new Uint8Array(CELL.w * CELL.h).fill(floor);
  for (let x = -16; x <= 16; x++) {
    const dy = Math.round(8 - Math.abs(x) / 2);
    for (const y of [CELL.ay - dy, CELL.ay + dy]) out[y * CELL.w + CELL.ax + x] = seam;
  }
  for (let y = 0; y < f.h; y++) {
    for (let x = 0; x < f.w; x++) {
      const v = f.img[y * f.w + x] ?? 0;
      if (v !== 0) out[(CELL.ay - f.ay + y) * CELL.w + CELL.ax - f.ax + x] = v;
    }
  }
  return out;
}

const rows = cat.colours.flatMap((c) => (["sw", "se"] as const).map((d) => ({ c, d, fs: pieceFrames(cat, c, d) })));
const cols = 7, W = CELL.w * cols, H = CELL.h * rows.length;
const strip = new Uint8Array(W * H);
rows.forEach(({ c, d, fs }, r) => {
  const pick = (k: string): (typeof fs)[number] => {
    const f = fs.find((x) => x.key === `furniture/cat/${c}/${k}`);
    if (!f) throw new Error(`missing ${k}`);
    return f;
  };
  const walk = [0, 1, 2, 3].map((n) => cell(pick(`walk/${d}/${String(n)}`)));
  [cell(pick(`${d}/back`)), ...walk, cell(pick(`sit/${d}`)), cell(pick(`bed/${d}`))].forEach((img, i) => {
    for (let y = 0; y < CELL.h; y++) strip.set(img.subarray(y * CELL.w, (y + 1) * CELL.w), (r * CELL.h + y) * W + i * CELL.w);
  });
  const big = walk.map((img) => upscale(img, CELL.w, CELL.h, 4));
  writeFileSync(join(OUT, `cat-walk-${c}-${d}@4x.apng`), encodeIndexedApng(CELL.w * 4, CELL.h * 4, big, big.map(() => cat.walk?.ms ?? 150), PALETTE));
});
// 1× strip above the 4× one, so readability at native size is judged on the same sheet.
const big = upscale(strip, W, H, 4), SW = W * 4, SH = H + 4 + H * 4;
const sheet = new Uint8Array(SW * SH).fill(colorIndex("wall", 1));
for (let y = 0; y < H; y++) sheet.set(strip.subarray(y * W, (y + 1) * W), y * SW);
for (let y = 0; y < H * 4; y++) sheet.set(big.subarray(y * SW, (y + 1) * SW), (H + 4 + y) * SW);
writeFileSync(join(OUT, "cat-walk@4x.png"), encodeIndexedPng(SW, SH, sheet, PALETTE));
