import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, FURNITURE, ROOM_SHELLS, RoomLayoutInputSchema, RoomLayoutSchema, ROOM_PRESET_IDS, footprintCells, layoutSeats } from "../src/index";

// Dank Dungeon (OME-1672, assets/README.md § "Dank Dungeon"): the preset id and the six v6 kinds.
describe("dank dungeon contract", () => {
  test("the preset id is part of the contract", () => {
    expect(ROOM_PRESET_IDS).toContain("dank-dungeon");
  });

  test("the six v6 kinds match the README table", () => {
    const spec = (k: string): unknown => (FURNITURE as Record<string, unknown>)[k];
    expect(spec("bed")).toMatchObject({ layer: "object", cols: 2, rows: 2, seats: true, wallBacked: false, variants: 1 });
    expect(spec("whirlpool")).toMatchObject({ layer: "object", cols: 2, rows: 1, seats: true, wallBacked: false });
    expect(spec("mirror")).toMatchObject({ layer: "wall", facings: ["se", "sw"], cols: 0, rows: 0 });
    expect(spec("minibar")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, seats: false });
    expect(spec("desk")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, wallBacked: false });
    expect(spec("washbasin")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, wallBacked: true });
    for (const k of ["bed", "whirlpool"]) expect((spec(k) as { facings: string[] }).facings).toEqual(["ne", "nw", "se", "sw"]);
  });

  // OME-1982: a queen bed, 2×2, and two sleepers side by side on its first row, whichever way it faces.
  test("a bed covers 2×2 and seats two side by side in every facing", () => {
    const bed = (facing: string) => ({ kind: "bed", col: 4, row: 0, facing }) as never;
    for (const facing of ["ne", "nw", "se", "sw"]) expect(footprintCells(bed(facing))).toEqual([[4, 0], [4, 1], [5, 0], [5, 1]]);
    for (const facing of ["ne", "sw"]) expect(layoutSeats({ furniture: [bed(facing)] })).toEqual([{ col: 4, row: 0, facing }, { col: 5, row: 0, facing }] as never);
    for (const facing of ["nw", "se"]) expect(layoutSeats({ furniture: [bed(facing)] })).toEqual([{ col: 4, row: 0, facing }, { col: 4, row: 1, facing }] as never);
  });

  test("a bed must fit on the floor and may not overlap", () => {
    const ok = (f: unknown[]) => v.safeParse(RoomLayoutSchema, { furniture: f }).success;
    const chairs = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6]].map(([col, row]) => ({ kind: "armchair", col, row, facing: "ne" }));
    const tv = { kind: "tv", col: 0, row: 0, facing: "se" };
    expect(ok([tv, ...chairs, { kind: "bed", col: 7, row: 7, facing: "ne" }])).toBe(true);
    expect(ok([tv, ...chairs, { kind: "bed", col: 8, row: 9, facing: "ne" }])).toBe(false);
    expect(ok([tv, ...chairs, { kind: "bed", col: 4, row: 5, facing: "ne" }])).toBe(false);
  });

  test("the washbasin must stand on its wall", () => {
    const issues = (f: unknown): string[] => (v.safeParse(RoomLayoutSchema, { furniture: [f] }).issues ?? []).map((i) => i.message);
    expect(issues({ kind: "washbasin", col: 3, row: 3, facing: "se" }).length).toBeGreaterThan(0);
  });

  // OME-1989 (decided on OME-1978): the v7 kinds, the v7 variants and the shell skin.
  test("the three v7 kinds", () => {
    expect(FURNITURE.sauna).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 2, rows: 2, seats: false, wallBacked: true, variants: 1 });
    expect(FURNITURE.soaktub).toMatchObject({ layer: "object", facings: ["se"], cols: 2, rows: 2, seats: true, wallBacked: false, variants: 1 });
    expect(FURNITURE.lounger).toMatchObject({ layer: "object", facings: ["ne", "nw", "se", "sw"], cols: 2, rows: 1, seats: true, lie: "lie", variants: 1 });
  });

  test("a soaktub seats two on its first row, a lounger one at its anchor", () => {
    expect(layoutSeats({ furniture: [{ kind: "soaktub", col: 4, row: 4, facing: "se" }] })).toEqual([{ col: 4, row: 4, facing: "se" }, { col: 4, row: 5, facing: "se" }]);
    for (const facing of ["ne", "nw", "se", "sw"] as const) expect(layoutSeats({ furniture: [{ kind: "lounger", col: 4, row: 4, facing }] })).toEqual([{ col: 4, row: 4, facing }]);
  });

  test("the sauna backs onto a wall", () => {
    const ok = (f: unknown): boolean => v.safeParse(RoomLayoutSchema, { ...DEFAULT_LAYOUT, furniture: [...DEFAULT_LAYOUT.furniture, f] }).success;
    expect(ok({ kind: "sauna", col: 3, row: 0, facing: "sw" })).toBe(true);
    expect(ok({ kind: "sauna", col: 3, row: 3, facing: "sw" })).toBe(false);
  });

  test("v7 variants: mirror, minibar, tv and carpet two, partition four", () => {
    expect([FURNITURE.mirror, FURNITURE.minibar, FURNITURE.tv, FURNITURE.carpet, FURNITURE.partition].map((s) => s.variants)).toEqual([2, 2, 2, 2, 4]);
  });

  test("layout.shell: optional, only dungeon, kept as sent", () => {
    expect(ROOM_SHELLS).toEqual(["dungeon"]);
    for (const schema of [RoomLayoutSchema, RoomLayoutInputSchema]) {
      expect(v.parse(schema, { ...DEFAULT_LAYOUT, shell: "dungeon" })).toMatchObject({ shell: "dungeon" });
      expect("shell" in v.parse(schema, DEFAULT_LAYOUT)).toBe(false);
      for (const shell of ["default", "Dungeon", "", null, 1, true]) expect(v.safeParse(schema, { ...DEFAULT_LAYOUT, shell }).success).toBe(false);
    }
  });
});
