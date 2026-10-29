import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, FURNITURE, FurnitureSchema, footprintCells, isStandable, layoutSeats } from "../src/index";

// The interior wall (OME-1958, spike OME-1957): a solid 1×1 piece, se/sw pick its axis; 0 solid, 1 glass. The doorway is a gap.

const at = (facing: "se" | "sw", variant = 0) => ({ kind: "partition" as const, col: 5, row: 4, facing, variant });
const room = (facing: "se" | "sw", variant = 0) => ({ ...DEFAULT_LAYOUT, furniture: [...DEFAULT_LAYOUT.furniture, at(facing, variant)] });

describe("partition", () => {
  test("an object-layer 1×1 piece, se/sw only, four variants (OME-1989), no seats", () => {
    expect(FURNITURE.partition).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, seats: false, variants: 4, wallBacked: false });
    expect(footprintCells(at("sw"))).toEqual([[5, 4]]);
  });

  test.each([["se"], ["sw"]] as const)("facing %s it parses, solid and glass in two looks; no doorframe, no ne/nw", (facing) => {
    expect(v.safeParse(FurnitureSchema, at(facing, 0)).success).toBe(true);
    expect(v.safeParse(FurnitureSchema, at(facing, 1)).success).toBe(true);
    expect(v.safeParse(FurnitureSchema, at(facing, 3)).success).toBe(true);
    expect(v.safeParse(FurnitureSchema, at(facing, 4)).success).toBe(false);
    expect(v.safeParse(FurnitureSchema, { ...at(facing), facing: facing === "se" ? "ne" : "nw" }).success).toBe(false);
  });

  test.each([["se", 0], ["se", 1], ["sw", 0], ["sw", 1]] as const)("facing %s variant %i blocks its cell and only it", (facing, variant) => {
    const l = room(facing, variant);
    expect(isStandable(l, { x: 5, y: 4 })).toBe(false);
    for (const [x, y] of [[5, 3], [5, 5], [4, 4]] as const) expect(isStandable(l, { x, y })).toBe(true);
    expect(layoutSeats(l)).toEqual(layoutSeats(DEFAULT_LAYOUT));
  });
});
