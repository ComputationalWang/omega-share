// Set (n): the shipped room presets are valid layouts (the same strict schema an owner's `layout-set` meets), and their
// thumbnails exist, have the manifest's size and stay inside the 40 KB budget (OME-906).
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { DOOR_CELL, RoomLayoutInputSchema, SEAT_COUNT, footprintCells, layoutSeats } from "@omega/shared";
import { PRESETS } from "./presets";

const DIR = join(import.meta.dir, "..", "presets");
const Manifest = v.strictObject({
  version: v.literal(1),
  license: v.literal("CC-BY-SA-4.0"),
  default: v.string(),
  thumb: v.strictObject({ w: v.number(), h: v.number(), scale: v.number() }),
  presets: v.array(v.strictObject({ id: v.pipe(v.string(), v.regex(/^[a-z-]{1,12}$/)), name: v.string(), blurb: v.pipe(v.string(), v.maxLength(60)), layout: v.string(), thumb: v.string() })),
});
const manifest = v.parse(Manifest, JSON.parse(readFileSync(join(DIR, "presets.json"), "utf8")));
const pngSize = (buf: Buffer): { w: number; h: number } => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

describe("room presets", () => {
  test("five to eight, unique ids, the default among them", () => {
    expect(manifest.presets.length).toBeGreaterThanOrEqual(5);
    expect(manifest.presets.length).toBeLessThanOrEqual(8);
    const ids = manifest.presets.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(manifest.default);
  });

  for (const entry of manifest.presets) {
    test(`${entry.id}: the layout file passes RoomLayoutInputSchema and matches presets.ts`, () => {
      const layout: unknown = JSON.parse(readFileSync(join(DIR, entry.layout), "utf8"));
      const parsed = v.safeParse(RoomLayoutInputSchema, layout);
      expect(parsed.issues?.map((i) => i.message) ?? []).toEqual([]);
      if (!parsed.success) return;
      expect(layoutSeats(parsed.output)).toHaveLength(SEAT_COUNT);
      // Every seat looks toward the TV corner.
      expect(layoutSeats(parsed.output).every((s) => s.facing === "ne" || s.facing === "nw")).toBe(true);
      expect(layout).toEqual(PRESETS.find((p) => p.id === entry.id)?.layout);
    });
  }

  test("one preset shows off at least three catalogue v3 pieces (OME-1351)", () => {
    const v3 = ["coffeetable", "pouf", "neonsign", "aquarium", "arcade", "wallclock"];
    const most = Math.max(...PRESETS.map((p) => new Set(p.layout.furniture.map((f) => f.kind).filter((k) => v3.includes(k))).size));
    expect(most).toBeGreaterThanOrEqual(3);
  });

  test("the Bar preset shows off at least four batch 6 pieces (OME-1439)", () => {
    const batch6 = ["hammock", "stool", "barcounter", "piano", "fireplace"];
    const bar = PRESETS.find((p) => p.id === "bar");
    expect(bar?.name).toBe("Bar");
    expect(new Set(bar?.layout.furniture.map((f) => f.kind).filter((k) => batch6.includes(k))).size).toBeGreaterThanOrEqual(4);
  });

  test("Dank Dungeon (OME-1672): night mood, pair emote on, the README's blurb; no other preset has pairs", () => {
    const dd = PRESETS.find((p) => p.id === "dank-dungeon");
    expect(dd?.name).toBe("Dank Dungeon");
    expect(dd?.blurb).toBe("Twin beds, a whirlpool for two, lights down.");
    expect(dd?.layout.mood).toBe("night");
    expect(dd?.layout.pairs).toBe(true);
    expect(PRESETS.filter((p) => p.layout.pairs === true).map((p) => p.id)).toEqual(["dank-dungeon"]);
    // OME-1989: the dungeon shell skin, on this preset only.
    expect(PRESETS.filter((p) => p.layout.shell !== undefined).map((p) => [p.id, p.layout.shell])).toEqual([["dank-dungeon", "dungeon"]]);
  });

  test("Dank Dungeon (OME-1960): two rooms split by row 4, solid and glass with a doorway at (1, 4); beds behind, the spa in front", () => {
    const f = PRESETS.find((p) => p.id === "dank-dungeon")?.layout.furniture ?? [];
    const walls = f.filter((x) => x.kind === "partition");
    expect(walls.every((w) => w.row === 4 && w.facing === "sw")).toBe(true);
    expect(walls.map((w) => [w.col, w.variant ?? 0]).sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0))).toEqual([[0, 0], [2, 0], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1]]);
    expect(f.filter((x) => x.kind === "bed").map((b) => [b.col, b.row, b.facing])).toEqual([[2, 2, "nw"], [5, 2, "nw"]]);
    for (const k of ["whirlpool", "washbasin", "mirror"]) expect(f.find((x) => x.kind === k)?.row).toBeGreaterThan(4);
  });

  test("Dank Dungeon (OME-2039): nothing stands on the way in, the doorway's cells or the room's door cell", () => {
    const f = PRESETS.find((p) => p.id === "dank-dungeon")?.layout.furniture ?? [];
    // The doorway at (1, 4) and the cells either side of it; DOOR_CELL is where people walk in.
    const keep = new Set([[1, 3], [1, 4], [1, 5], [DOOR_CELL.x, DOOR_CELL.y]].map(([c, r]) => `${String(c)},${String(r)}`));
    expect(f.flatMap((x) => footprintCells(x).filter(([c, r]) => keep.has(`${String(c)},${String(r)}`)).map(() => x.kind))).toEqual([]);
  });

  test("Dank Dungeon (OME-2039): every chair faces the beds, one from beside the glass", () => {
    const f = PRESETS.find((p) => p.id === "dank-dungeon")?.layout.furniture ?? [];
    const beds = f.filter((x) => x.kind === "bed").flatMap(footprintCells);
    const ahead = { nw: [-1, 0], ne: [0, -1], se: [1, 0], sw: [0, 1] } as const;
    const chairs = f.filter((x) => x.kind === "wingback");
    expect(chairs.length).toBeGreaterThanOrEqual(2);
    for (const c of chairs) {
      // A chair faces the beds when a bed cell lies straight ahead of it (its row or col, in its facing's direction).
      const [dc, dr] = ahead[c.facing];
      const facesBed = beds.some(([bc, br]) => (dc === 0 ? bc === c.col && (br - c.row) * dr > 0 : br === c.row && (bc - c.col) * dc > 0));
      expect([c.col, c.row, c.facing, facesBed]).toEqual([c.col, c.row, c.facing, true]);
    }
    // Beside the glass (cols 3–9 on row 4), on the spa side, looking in.
    expect(chairs.some((c) => c.row === 5 && c.col >= 3 && c.facing === "ne")).toBe(true);
  });

  test("thumbnails: one per preset at the manifest size, ≤ 40 KB together, no strays", () => {
    let bytes = 0;
    for (const entry of manifest.presets) {
      const buf = readFileSync(join(DIR, entry.thumb));
      expect(pngSize(buf)).toEqual({ w: manifest.thumb.w, h: manifest.thumb.h });
      bytes += buf.length;
    }
    expect(bytes).toBeLessThanOrEqual(40 * 1024);
    const files = readdirSync(join(DIR, "thumbs")).sort();
    expect(files).toEqual(manifest.presets.map((p) => p.thumb.replace("thumbs/", "")).sort());
  });
});
