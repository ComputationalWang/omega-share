import { describe, expect, test } from "bun:test";
import { cellCenter } from "../src/layout";
import { cursorStrokes, markerKeys, slotAt, step, type Slot } from "../src/editor/pick";

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

describe("step: the editor's keyboard cursor (OME-1245)", () => {
  const floor = (col: number, row: number): Slot => ({ col, row, wall: null });
  test("on the floor, Right/Left walk the column and Down/Up the row, stopping at the far edges", () => {
    expect(step(floor(3, 4), "ArrowRight")).toEqual(floor(4, 4));
    expect(step(floor(3, 4), "ArrowLeft")).toEqual(floor(2, 4));
    expect(step(floor(3, 4), "ArrowDown")).toEqual(floor(3, 5));
    expect(step(floor(3, 4), "ArrowUp")).toEqual(floor(3, 3));
    expect(step(floor(9, 4), "ArrowRight")).toEqual(floor(9, 4));
    expect(step(floor(3, 9), "ArrowDown")).toEqual(floor(3, 9));
  });

  test("up from the back row is the right wall's slot, left from the first column the left wall's, and back down again", () => {
    expect(step(floor(2, 0), "ArrowUp")).toEqual({ col: 2, row: 0, wall: "sw" });
    expect(step(floor(0, 6), "ArrowLeft")).toEqual({ col: 0, row: 6, wall: "se" });
    expect(step({ col: 2, row: 0, wall: "sw" }, "ArrowDown")).toEqual(floor(2, 0));
    expect(step({ col: 0, row: 6, wall: "se" }, "ArrowRight")).toEqual(floor(0, 6));
  });

  test("along a wall the cursor walks its slots and stays on the wall", () => {
    expect(step({ col: 2, row: 0, wall: "sw" }, "ArrowRight")).toEqual({ col: 3, row: 0, wall: "sw" });
    expect(step({ col: 2, row: 0, wall: "sw" }, "ArrowLeft")).toEqual({ col: 1, row: 0, wall: "sw" });
    expect(step({ col: 2, row: 0, wall: "sw" }, "ArrowUp")).toEqual({ col: 2, row: 0, wall: "sw" });
    expect(step({ col: 9, row: 0, wall: "sw" }, "ArrowRight")).toEqual({ col: 9, row: 0, wall: "sw" });
    expect(step({ col: 0, row: 6, wall: "se" }, "ArrowDown")).toEqual({ col: 0, row: 7, wall: "se" });
    expect(step({ col: 0, row: 6, wall: "se" }, "ArrowUp")).toEqual({ col: 0, row: 5, wall: "se" });
    expect(step({ col: 0, row: 6, wall: "se" }, "ArrowLeft")).toEqual({ col: 0, row: 6, wall: "se" });
  });
});

describe("cursorStrokes: the keyboard cursor keeps its on-screen width at any stage scale (QA OME-1274)", () => {
  test("on screen the light line is at least 2 px and the dark one at least 5 px (1.5 px each side), however small the room is shown", () => {
    // 0.29: the editor's room at 1280×720 and 1920×1080 (278 px wide).
    for (const scale of [0.29, 0.5, 1, 1.5, 2]) {
      const { dark, light } = cursorStrokes(scale);
      expect(light * scale).toBeGreaterThanOrEqual(2);
      expect(dark * scale).toBeGreaterThanOrEqual(5);
    }
  });

  test("at full size and above it stays the drawn design (5 under 2.5), not thinner", () => {
    expect(cursorStrokes(1)).toEqual({ dark: 5, light: 2.5 });
    expect(cursorStrokes(2)).toEqual({ dark: 5, light: 2.5 });
  });

  test("a stage not laid out yet (scale 0 or not finite) draws the design widths", () => {
    expect(cursorStrokes(0)).toEqual({ dark: 5, light: 2.5 });
    expect(cursorStrokes(Number.NaN)).toEqual({ dark: 5, light: 2.5 });
  });
});
