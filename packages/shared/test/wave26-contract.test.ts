import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FURNITURE, ROOM_SHELLS, RoomLayoutInputSchema, RoomLayoutSchema, isScreen, isSolid, isStandable, layoutSeats, partitionLine } from "../src/index";
import { REEF, STAGE_DOOR } from "./wave26-layouts";

// Rooms wave 26 (OME-2439, concepts OME-2434): stage, vanity, rack; partition velvet, wings, tank, tunnel (walkable);
// lavalamp bubbles; the stage-door and reef shells and their layouts.

const CHAIRS = ([[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const).map(([col, row]) => ({ kind: "armchair", col, row, facing: "ne" }));
const TV = { kind: "tv", col: 0, row: 0, facing: "se" } as const;
const room = (...furniture: unknown[]): { furniture: unknown[] } => ({ furniture: [TV, ...CHAIRS, ...furniture] });
const ok = (input: unknown): boolean => v.safeParse(RoomLayoutInputSchema, input).success && v.safeParse(RoomLayoutSchema, input).success;
const spec = (k: string): unknown => (FURNITURE as Record<string, unknown>)[k];

describe("the three wave 26 kinds", () => {
  test("stage 3×2, vanity wall-backed, rack 2×1; none seats or is a screen", () => {
    expect(spec("stage")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 3, rows: 2, seats: false, variants: 1, wallBacked: false });
    expect(spec("vanity")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, seats: false, variants: 1, wallBacked: true });
    expect(spec("rack")).toMatchObject({ layer: "object", facings: ["se", "sw"], cols: 2, rows: 1, seats: false, variants: 1, wallBacked: false });
    for (const k of ["stage", "vanity", "rack"] as const) expect(isScreen(k)).toBe(false);
  });

  test("a stage covers 3×2 and turns with its facing", () => {
    expect(ok(room({ kind: "stage", col: 7, row: 8, facing: "sw" }))).toBe(true);
    expect(ok(room({ kind: "stage", col: 8, row: 8, facing: "sw" }))).toBe(false);
    expect(ok(room({ kind: "stage", col: 8, row: 7, facing: "se" }))).toBe(true);
    expect(ok(room({ kind: "stage", col: 8, row: 8, facing: "ne" }))).toBe(false);
  });

  test("a vanity backs onto a wall, a rack stands free", () => {
    expect(ok(room({ kind: "vanity", col: 0, row: 8, facing: "se" }))).toBe(true);
    expect(ok(room({ kind: "vanity", col: 8, row: 0, facing: "sw" }))).toBe(true);
    expect(ok(room({ kind: "vanity", col: 3, row: 8, facing: "se" }))).toBe(false);
    expect(ok(room({ kind: "rack", col: 8, row: 9, facing: "sw" }))).toBe(true);
    expect(ok(room({ kind: "rack", col: 9, row: 9, facing: "sw" }))).toBe(false);
  });
});

test("partition takes velvet, wings, tank and tunnel (variants 4–7); lavalamp takes bubbles (1)", () => {
  expect(FURNITURE.partition.variants).toBe(8);
  expect(FURNITURE.lavalamp.variants).toBe(2);
  expect(ok(room({ kind: "partition", col: 5, row: 9, facing: "sw", variant: 7 }))).toBe(true);
  expect(ok(room({ kind: "partition", col: 5, row: 9, facing: "sw", variant: 8 }))).toBe(false);
  expect(ok(room({ kind: "lavalamp", col: 9, row: 9, facing: "se", variant: 1 }))).toBe(true);
  expect(ok(room({ kind: "lavalamp", col: 9, row: 9, facing: "se", variant: 2 }))).toBe(false);
});

describe("partition/tunnel is walkable (CEO: option A)", () => {
  const at = (variant: number) => ({ furniture: [{ kind: "partition", col: 5, row: 4, facing: "sw", variant } as const] });

  test("the tunnel is floor; every other partition colour stays solid", () => {
    expect(isStandable(at(7), { x: 5, y: 4 })).toBe(true);
    for (const variant of [0, 1, 2, 3, 4, 5, 6]) expect(isStandable(at(variant), { x: 5, y: 4 })).toBe(false);
    expect(isSolid({ kind: "partition", col: 5, row: 4, facing: "sw", variant: 7 })).toBe(false);
    expect(isSolid({ kind: "partition", col: 5, row: 4, facing: "sw" })).toBe(true);
    expect(isSolid({ kind: "lavalamp", col: 5, row: 4, facing: "se", variant: 7 })).toBe(true);
  });

  test("it still takes its cell: nothing solid may share it", () => {
    expect(ok(room({ kind: "partition", col: 9, row: 9, facing: "sw", variant: 7 }, { kind: "plant", col: 9, row: 9, facing: "se" }))).toBe(false);
  });

  test("in Reef the tunnel is the only way from the bar to the deep", () => {
    expect(isStandable(REEF, { x: 3, y: 4 })).toBe(true);
    for (let col = 0; col < 10; col++) if (col !== 3) expect(isStandable(REEF, { x: col, y: 4 })).toBe(false);
  });
});

test("the shells gain stage-door and reef", () => {
  expect(ROOM_SHELLS).toEqual(["dungeon", "penthouse", "studio", "stage-door", "reef"]);
});

describe("the wave 26 layouts", () => {
  test("Stage Door: valid, 8 seats, one column partition line with the stage door at (4, 7)", () => {
    expect(ok(STAGE_DOOR)).toBe(true);
    expect(layoutSeats(STAGE_DOOR)).toHaveLength(8);
    expect(partitionLine(STAGE_DOOR)).toEqual({ axis: "col", at: 4 });
    expect(isStandable(STAGE_DOOR, { x: 4, y: 7 })).toBe(true);
    expect(STAGE_DOOR.furniture.filter((f) => f.kind === "partition")).toHaveLength(9);
  });

  test("Reef: valid, 8 seats, one row partition line", () => {
    expect(ok(REEF)).toBe(true);
    expect(layoutSeats(REEF)).toHaveLength(8);
    expect(partitionLine(REEF)).toEqual({ axis: "row", at: 4 });
  });

  test("4 seats on each side of the line", () => {
    const side = (l: unknown, axis: "col" | "row") => layoutSeats(l).filter((s) => s[axis] < 4).length;
    expect(side(STAGE_DOOR, "col")).toBe(4);
    expect(side(REEF, "row")).toBe(4);
  });
});
