import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FURNITURE, ROOM_SHELLS, RoomLayoutInputSchema, RoomLayoutSchema, SCREEN_KINDS, isScreen, partitionLine } from "../src/index";

// Rooms wave 2 contract (OME-2065, ADR 0058): wall screens with a wall span, one partition line, the new shells.

const CHAIRS = ([[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const).map(([col, row]) => ({ kind: "armchair", col, row, facing: "ne" }));
const TV = { kind: "tv", col: 0, row: 0, facing: "se" };
const room = (...furniture: unknown[]): unknown => ({ furniture: [...CHAIRS, ...furniture] });
const ok = (input: unknown): boolean => v.safeParse(RoomLayoutInputSchema, input).success && v.safeParse(RoomLayoutSchema, input).success;
const screen = (kind: "wallscreen" | "projector", col: number, row: number, facing = row === 0 ? "sw" : "se"): unknown => ({ kind, col, row, facing });

describe("wall screens", () => {
  test("wallscreen spans 2 wall segments, projector 3; both hang on a wall facing se or sw", () => {
    expect(FURNITURE.wallscreen).toMatchObject({ layer: "wall", facings: ["se", "sw"], cols: 0, rows: 0, seats: false, variants: 1, wallSpan: 2 });
    expect(FURNITURE.projector).toMatchObject({ layer: "wall", facings: ["se", "sw"], cols: 0, rows: 0, seats: false, variants: 1, wallSpan: 3 });
    expect(FURNITURE.frame.wallSpan).toBeUndefined();
  });

  test("they are screen kinds, and isScreen follows SCREEN_KINDS", () => {
    expect(SCREEN_KINDS).toEqual(["tv", "bigscreen", "wallscreen", "projector"]);
    for (const kind of SCREEN_KINDS) expect(isScreen(kind)).toBe(true);
    expect(isScreen("frame") || isScreen("lamp")).toBe(false);
  });

  test("a wall screen is the room's one screen", () => {
    expect(ok(room(screen("wallscreen", 1, 0)))).toBe(true);
    expect(ok(room(screen("projector", 0, 1)))).toBe(true);
    expect(ok(room(TV, screen("wallscreen", 1, 0)))).toBe(false);
    expect(ok(room(screen("wallscreen", 1, 0), screen("projector", 0, 1)))).toBe(false);
  });

  test("the span stays on its wall: off the fixture segments 5, 6, 8 and inside the 10 segments", () => {
    // wallscreen: segments n, n+1; projector: n..n+2. Fixtures at 5, 6, 8.
    expect(ok(room(screen("wallscreen", 3, 0)))).toBe(true);
    expect(ok(room(screen("wallscreen", 4, 0)))).toBe(false);
    expect(ok(room(screen("projector", 2, 0)))).toBe(true);
    expect(ok(room(screen("projector", 3, 0)))).toBe(false);
    expect(ok(room(screen("projector", 0, 3)))).toBe(false);
    expect(ok(room(screen("wallscreen", 0, 9)))).toBe(false);
    expect(ok(room(screen("wallscreen", 9, 0)))).toBe(false);
    expect(ok(room(screen("wallscreen", 1, 1)))).toBe(false);
  });

  test("no other wall piece on any segment of the span", () => {
    expect(ok(room(screen("projector", 1, 0), { kind: "frame", col: 3, row: 0, facing: "sw" }))).toBe(false);
    expect(ok(room(screen("projector", 1, 0), { kind: "frame", col: 4, row: 0, facing: "sw" }))).toBe(true);
    expect(ok(room(screen("projector", 1, 0), { kind: "frame", col: 0, row: 2, facing: "se" }))).toBe(true);
    expect(ok(room(screen("wallscreen", 0, 2), { kind: "mirror", col: 0, row: 3, facing: "se" }))).toBe(false);
  });
});

describe("partitions", () => {
  const part = (col: number, row: number, facing: "se" | "sw"): unknown => ({ kind: "partition", col, row, facing });

  test("one line: sw partitions on one row, or se partitions on one column", () => {
    expect(ok(room(TV, part(8, 9, "sw"), part(9, 9, "sw")))).toBe(true);
    expect(ok(room(TV, part(9, 8, "se"), part(9, 9, "se")))).toBe(true);
  });

  test("more than one line is refused, on either axis or across both", () => {
    expect(ok(room(TV, part(9, 8, "sw"), part(9, 9, "sw")))).toBe(false);
    expect(ok(room(TV, part(8, 9, "se"), part(9, 9, "se")))).toBe(false);
    expect(ok(room(TV, part(8, 9, "sw"), part(9, 9, "se")))).toBe(false);
  });

  test("partitionLine names the line, or undefined without partitions", () => {
    expect(partitionLine({ furniture: [TV] })).toBeUndefined();
    expect(partitionLine({ furniture: [TV, { kind: "partition", col: 3, row: 4, facing: "sw" }] })).toEqual({ axis: "row", at: 4 });
    expect(partitionLine({ furniture: [TV, { kind: "partition", col: 6, row: 2, facing: "se" }] })).toEqual({ axis: "col", at: 6 });
  });
});

test("the shells: dungeon, penthouse, studio", () => {
  expect(ROOM_SHELLS).toEqual(["dungeon", "penthouse", "studio"]);
  for (const shell of ROOM_SHELLS) expect(ok({ ...(room(TV) as object), shell })).toBe(true);
});
