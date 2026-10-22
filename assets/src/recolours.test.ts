// Furniture recolours (OME-1462): the PLTE swap gives exactly what a direct render in the target ramp gives, touches only the
// piece's fabric, and every new colour stays apart from its siblings and reads on the floor and the dark site bg.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PIECES, pieceImage, type Canvas } from "./furniture";
import { PALETTE, RAMPS, colorIndex, type RampName } from "./palette";
import { MOODS, RECOLOURS, SITE_BG, WALL_KINDS, recolourCells, recolourRemap, sourcePieceFrames } from "./recolours";
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

/** One body colour named by its ramp (fabric seats, shades, pots, cases): compare that ramp. Else (prints, bulbs, brass) compare pixels. */
const oneColour = (kind: string): boolean => !WALL_KINDS.has(kind) && allCells.filter((c) => c.kind === kind).every((c) => c.variant in RAMPS);

test("OME-1688: every lamp, plant and shelf has 2 new colourways", () => {
  for (const kind of ["lamp", "plant", "arclamp", "monstera", "bookshelf", "wallshelf"]) expect(RECOLOURS[kind]?.variants.length).toBe(2);
});

describe.each(Object.entries(RECOLOURS))("%s", (kind, r) => {
  const cells = allCells.filter((c) => c.kind === kind);
  test("2 new colours after the shipped ones, all ids distinct", () => {
    expect(r.variants.length).toBe(2);
    expect(cells.length).toBe(r.existing + 2);
    expect(new Set(cells.map((c) => c.variant)).size).toBe(cells.length);
  });
  test.skipIf(!oneColour(kind))("new colours: ΔE ≥ 20 from every sibling (also deutan/protan), ΔE ≥ 25 from the floor, ≥ 3:1 on the dark site bg", () => {
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
    const keys = r.sheet === "room/room.png" ? roomFrames.map((f) => f.key) : frames.map((f) => f.key);
    expect(keys.some((k) => k.startsWith(r.frames))).toBe(true);
    const edit = Object.keys((JSON.parse(readFileSync(join(ROOT, "ui", "edit.json"), "utf8")) as { frames: object }).frames);
    if (r.thumb) expect(edit).toContain(r.thumb);
    for (const v of r.variants) expect(edit).toContain(`swatch/${v.id}`);
  });
});

// Wall decor (OME-1500) and the arc lamp (OME-1688): a print, a string of bulbs or a brass lamp has no one colour, so compare variants where they differ.
const hex = (rgb: readonly number[]): string => "#" + rgb.map((x) => Math.round(x).toString(16).padStart(2, "0")).join("");
const mix = (h: string, mood: (typeof MOODS)[number]): string => {
  const n = Number.parseInt(h.slice(1), 16);
  return hex([(n >> 16) & 255, (n >> 8) & 255, n & 255].map((x, k) => x * (1 - mood.a) + (mood.rgb[k] ?? 0) * mood.a));
};

describe.each(Object.keys(RECOLOURS).filter((k) => !oneColour(k)))("%s (by pixel)", (kind) => {
  const cells = allCells.filter((c) => c.kind === kind);
  const r = RECOLOURS[kind];
  test("each new variant vs every sibling: where they differ, the pixels are ΔE ≥ 20 apart on average (also deutan/protan)", () => {
    for (const v of r?.variants ?? []) {
      const a = cells.find((c) => c.variant === v.id);
      for (const b of cells.filter((c) => c !== a)) {
        let sum = 0, n = 0;
        a?.images.forEach((m, i) => {
          const o = b.images[i];
          expect([o?.w, o?.h]).toEqual([m.w, m.h]);
          m.img.forEach((x, j) => {
            const y = o?.img[j] ?? 0, cx = PALETTE[x], cy = PALETTE[y];
            if (x === y || x === 0 || y === 0 || !cx || !cy) return;
            sum += cvdDeltaE(hex([cx.r, cx.g, cx.b]), hex([cy.r, cy.g, cy.b]));
            n++;
          });
        });
        expect(n).toBeGreaterThan(0);
        expect(sum / n).toBeGreaterThanOrEqual(20);
      }
    }
  });
  test.skipIf(kind !== "garland")("new bulbs: ≥ 3:1 on the dark site bg, and on the wall in every mood no weaker than the weakest shipped bulb (party's lilac)", () => {
    const wall = RAMPS.wall[1];
    for (const mood of MOODS) {
      const floor = Math.min(...(["glow", "mustard", "pink", "teal", "lilac"] as const).map((b) => contrast(mix(RAMPS[b][1], mood), mix(wall, mood))));
      for (const v of r?.variants ?? []) for (const b of v.to) expect(contrast(mix(RAMPS[b][1], mood), mix(wall, mood))).toBeGreaterThanOrEqual(floor);
    }
    for (const v of r?.variants ?? []) for (const b of v.to) expect(contrast(RAMPS[b][1], SITE_BG)).toBeGreaterThanOrEqual(3);
  });
});

// OME-1707 judge polish: a new arc lamp holds 3:1 on the dark site bg; a new case (its shade tone) or plank holds 1.5:1 on its backdrop in every mood.
test("OME-1707: new arc lamps, cases and planks don't vanish on the site bg or the lightest mood", () => {
  const moodMin = (h: string, bg: string): number => Math.min(...MOODS.map((m) => contrast(mix(h, m), mix(bg, m))));
  for (const v of RECOLOURS.arclamp?.variants ?? []) expect(contrast(RAMPS[v.to[0] ?? "outline"][1], SITE_BG)).toBeGreaterThanOrEqual(3);
  for (const v of RECOLOURS.bookshelf?.variants ?? []) expect(moodMin(RAMPS[v.shade ?? v.to[0] ?? "floor"][2], RAMPS.floor[1])).toBeGreaterThanOrEqual(1.5);
  for (const v of RECOLOURS.wallshelf?.variants ?? []) expect(moodMin(RAMPS[v.to[0] ?? "wall"][1], RAMPS.wall[1])).toBeGreaterThanOrEqual(1.5);
});
