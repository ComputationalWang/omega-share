// Furniture recolours (OME-1462): the PLTE swap gives exactly what a direct render in the target ramp gives, touches only the
// piece's fabric, and every new colour stays apart from its siblings and reads on the floor and the dark site bg.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIECES, pieceImage, type Canvas } from "./furniture";
import { RAMPS, colorIndex, type RampName } from "./palette";
import { RECOLOURS, recolourCells, recolourRemap, sourcePieceFrames } from "./recolours";
import { buildRoomFrames } from "./room";
import { applyRemap, contrast, cvdDeltaE, deltaE } from "./tints";

const ROOT = join(import.meta.dir, "..");
const table = JSON.parse(readFileSync(join(ROOT, "furniture", "recolours.json"), "utf8")) as {
  kinds: Record<string, { sheet: string; thumb?: string; slots: number[]; variants: { variant: number; id: string; colors: string[] }[] }>;
};
const frames = sourcePieceFrames();
const allCells = recolourCells();
/** Built once: ~4 s each, so per-test calls sit at bun's 5 s timeout on CI (OME-1472). */
const roomFrames = buildRoomFrames();
/** Byte equality: expect().toEqual on 190 k-element typed arrays is very slow. */
const same = (a: Uint8Array, b: Uint8Array | undefined): boolean => b !== undefined && Buffer.from(a).equals(Buffer.from(b));
const CV: Canvas = { w: 480, h: 400, ax: 220, ay: 300 };

function plte(file: string): string[] {
  const b = readFileSync(join(ROOT, file));
  for (let o = 8; o < b.length; ) {
    const len = b.readUInt32BE(o);
    if (b.toString("latin1", o + 4, o + 8) === "PLTE") return Array.from({ length: len / 3 }, (_, i) => "#" + b.subarray(o + 8 + 3 * i, o + 11 + 3 * i).toString("hex"));
    o += 12 + len;
  }
  throw new Error(`${file}: no PLTE`);
}

test("the swap reproduces a shipped colour exactly (velvet → navy sofa, blush → navy beanbag, rust → lilac pouf, lilac → teal runner)", () => {
  const cases: [string, string, string, RampName[]][] = [["sofa", "velvet", "navy", ["navy"]], ["beanbag", "blush", "navy", ["navy"]], ["pouf", "rust", "lilac", ["lilac"]], ["rug", "lilac", "teal", ["teal", "mustard"]]];
  for (const [id, from, to, ramps] of cases) {
    const r = RECOLOURS[id === "rug" ? "runner" : id];
    if (!r) throw new Error(id);
    const remap = recolourRemap({ ...r, variants: [{ id: to, to: ramps }] }, 0);
    const src = frames.filter((f) => f.key.startsWith(`furniture/${id}/${from}/`));
    expect(src.length).toBeGreaterThan(0);
    for (const f of src) expect(same(applyRemap(f.img, remap), frames.find((g) => g.key === f.key.replace(`/${from}/`, `/${to}/`))?.img)).toBe(true);
  }
});

test("every new seat colour equals a direct render of the piece in that ramp, every facing", () => {
  for (const id of ["sofa", "beanbag", "pouf", "stool"]) {
    const r = RECOLOURS[id], def = PIECES.find((p) => p.id === id);
    if (!r || !def) throw new Error(id);
    const from = r.frames.split("/")[2] ?? "";
    r.variants.forEach((v, i) => {
      for (const d of def.dirs) expect(same(applyRemap(pieceImage(def, from, d, 1, CV), recolourRemap(r, i)), pieceImage(def, v.to[0] ?? "", d, 1, CV))).toBe(true);
    });
  }
}, 60_000);

test("the room rug's swapped ramps never touch the floor planks", () => {
  const r = RECOLOURS["rug"];
  const swapped = new Set(r?.from.flatMap((f) => [0, 1, 2].map((t) => colorIndex(f, t as 0 | 1 | 2))));
  for (const f of roomFrames.filter((g) => g.key.startsWith("floor/"))) expect([...f.img].some((v) => swapped.has(v))).toBe(false);
});

describe.each(Object.entries(RECOLOURS))("%s", (kind, r) => {
  const cells = allCells.filter((c) => c.kind === kind);
  test("2 new colours after the shipped ones, all ids distinct", () => {
    expect(r.variants.length).toBe(2);
    expect(cells.length).toBe(r.existing + 2);
    expect(new Set(cells.map((c) => c.variant)).size).toBe(cells.length);
  });
  test("new colours: ΔE ≥ 20 from every sibling (also deutan/protan), ΔE ≥ 25 from the floor, ≥ 3:1 on the dark site bg", () => {
    const base = (id: string): string => RAMPS[id as RampName][1];
    for (const v of r.variants) {
      for (const s of cells.map((c) => c.variant).filter((id) => id !== v.id)) expect(cvdDeltaE(base(v.id), base(s))).toBeGreaterThanOrEqual(20);
      expect(deltaE(base(v.id), RAMPS.floor[1])).toBeGreaterThanOrEqual(25);
      expect(contrast(base(v.id), "#1d1a2b")).toBeGreaterThanOrEqual(3);
    }
  });
  test("recolours.json slots hold the source colours in the sheet and in ui/edit.png", () => {
    const row = table.kinds[kind];
    const want = r.from.flatMap((f) => [...RAMPS[f]]);
    for (const file of [r.sheet, ...(r.thumb ? ["ui/edit.png"] : [])]) expect(row?.slots.map((i) => plte(file)[i])).toEqual(want);
    expect(row?.variants.map((v) => v.variant)).toEqual([r.existing, r.existing + 1]);
  });
  test("the source frames, thumb and swatch chips exist", () => {
    const keys = kind === "rug" ? roomFrames.map((f) => f.key) : frames.map((f) => f.key);
    expect(keys.some((k) => k.startsWith(r.frames))).toBe(true);
    const edit = Object.keys((JSON.parse(readFileSync(join(ROOT, "ui", "edit.json"), "utf8")) as { frames: object }).frames);
    if (r.thumb) expect(edit).toContain(r.thumb);
    for (const v of r.variants) expect(edit).toContain(`swatch/${v.id}`);
  });
});
