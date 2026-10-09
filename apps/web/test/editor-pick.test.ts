import { describe, expect, test } from "bun:test";
import { cellCenter } from "../src/layout";
import { markerKeys, slotAt } from "../src/editor/pick";

describe("slotAt: a click on the stage to the floor cell or wall slot under it", () => {
  test("a cell's centre and points inside its diamond pick that cell", () => {
    const c = cellCenter(2, 3);
    expect(slotAt(c.x, c.y)).toEqual({ col: 2, row: 3, wall: null });
    expect(slotAt(c.x + 12, c.y + 4)).toEqual({ col: 2, row: 3, wall: null });
    expect(slotAt(c.x, c.y - 7)).toEqual({ col: 2, row: 3, wall: null });
  });

  test("the floor's corners are cells (0,0) and (9,9)", () => {
    expect(slotAt(480, 236)).toEqual({ col: 0, row: 0, wall: null });
    const far = cellCenter(9, 9);
    expect(slotAt(far.x, far.y)).toEqual({ col: 9, row: 9, wall: null });
  });

  test("above the floor's right edge is the right wall's slot (col, 0) facing sw; above the left edge, (0, row) facing se", () => {
    const right = cellCenter(4, 0);
    expect(slotAt(right.x + 16, right.y - 40)).toEqual({ col: 4, row: 0, wall: "sw" });
    const left = cellCenter(0, 6);
    expect(slotAt(left.x - 16, left.y - 40)).toEqual({ col: 0, row: 6, wall: "se" });
  });

  test("off the room is nothing", () => {
    expect(slotAt(10, 590)).toBeNull();
    expect(slotAt(950, 590)).toBeNull();
    expect(slotAt(480, 0)).toBeNull();
  });
});

describe("markerKeys: the set (h) footprint markers for a piece", () => {
  test("one ring around the whole footprint, slanted by facing", () => {
    expect(markerKeys({ kind: "armchair", col: 1, row: 5, facing: "ne" }, "ok")).toEqual([{ key: "place/ok/1x1", col: 1, row: 5 }]);
    expect(markerKeys({ kind: "sofa", col: 3, row: 3, facing: "ne" }, "sel")).toEqual([{ key: "place/sel/2x1", col: 3, row: 3 }]);
    expect(markerKeys({ kind: "sofa", col: 3, row: 3, facing: "se" }, "no")).toEqual([{ key: "place/no/1x2", col: 3, row: 3 }]);
    expect(markerKeys({ kind: "runner", col: 2, row: 2, facing: "nw" }, "ok")).toEqual([{ key: "place/ok/2x3", col: 2, row: 2 }]);
  });

  test("a print gets its wall marker; there is no selected wall ring, so it shows ok", () => {
    expect(markerKeys({ kind: "frame", col: 3, row: 0, facing: "sw" }, "no")).toEqual([{ key: "place/no/wall-sw", col: 3, row: 0 }]);
    expect(markerKeys({ kind: "frame", col: 0, row: 3, facing: "se" }, "sel")).toEqual([{ key: "place/ok/wall-se", col: 0, row: 3 }]);
  });

  test("a footprint the kit has no ring for (the 7×7 rug) gets a 1×1 ring per cell", () => {
    const keys = markerKeys({ kind: "rug", col: 1, row: 1, facing: "se" }, "sel");
    expect(keys).toHaveLength(49);
    expect(keys[0]).toEqual({ key: "place/sel/1x1", col: 1, row: 1 });
    expect(keys[48]).toEqual({ key: "place/sel/1x1", col: 7, row: 7 });
  });
});
