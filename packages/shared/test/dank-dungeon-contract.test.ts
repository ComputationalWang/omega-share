import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FURNITURE, RoomLayoutSchema, ROOM_PRESET_IDS, footprintCells, layoutSeats } from "../src/index";

// Dank Dungeon (OME-1672, assets/README.md § "Dank Dungeon"): the preset id and the six v6 kinds.
describe("dank dungeon contract", () => {
  test("the preset id is part of the contract", () => {
    expect(ROOM_PRESET_IDS).toContain("dank-dungeon");
  });

  test("the six v6 kinds match the README table", () => {
    const spec = (k: string): unknown => (FURNITURE as Record<string, unknown>)[k];
    expect(spec("bed")).toMatchObject({ layer: "object", cols: 2, rows: 1, seats: true, wallBacked: false, variants: 1 });
    expect(spec("whirlpool")).toMatchObject({ layer: "object", cols: 2, rows: 1, seats: true, wallBacked: false });
    expect(spec("mirror")).toMatchObject({ layer: "wall", facings: ["se", "sw"], cols: 0, rows: 0 });
    expect(spec("minibar")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, seats: false });
    expect(spec("desk")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, wallBacked: false });
    expect(spec("washbasin")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, wallBacked: true });
    for (const k of ["bed", "whirlpool"]) expect((spec(k) as { facings: string[] }).facings).toEqual(["ne", "nw", "se", "sw"]);
  });

  test("a bed seats two on its footprint", () => {
    const bed = { kind: "bed", col: 4, row: 0, facing: "nw" } as never;
    expect(footprintCells(bed)).toEqual([[4, 0], [4, 1]]);
    expect(layoutSeats({ furniture: [bed] })).toHaveLength(2);
  });

  test("the washbasin must stand on its wall", () => {
    const issues = (f: unknown): string[] => (v.safeParse(RoomLayoutSchema, { furniture: [f] }).issues ?? []).map((i) => i.message);
    expect(issues({ kind: "washbasin", col: 3, row: 3, facing: "se" }).length).toBeGreaterThan(0);
  });
});
