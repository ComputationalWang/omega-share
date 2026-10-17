import { describe, expect, test } from "bun:test";
import { Graphics, Polygon } from "pixi.js";
import { drawCursor } from "../src/cell-cursor";
import type { Slot } from "../src/editor/pick";

/** Every shape the Graphics strokes, with whether its path closes (Pixi v8: `closePath` on the polygon). */
function strokedShapes(g: Graphics): { closePath: boolean | null }[] {
  return g.context.instructions.flatMap((i) => (i.action === "stroke" ? i.data.path.shapePath.shapePrimitives.map((p) => ({ closePath: p.shape instanceof Polygon ? p.shape.closePath : null })) : []));
}

describe("drawCursor: the keyboard cursor's outline (OME-1245)", () => {
  const slots: Slot[] = [
    { col: 4, row: 4, wall: null },
    { col: 4, row: 0, wall: "sw" },
    { col: 0, row: 4, wall: "se" },
  ];
  test("on the floor and both walls, the dark and the light line are closed shapes, all four sides drawn (QA OME-1276)", () => {
    for (const slot of slots) {
      const g = new Graphics();
      drawCursor(g, slot, 0.29);
      const shapes = strokedShapes(g);
      expect(shapes).toHaveLength(2);
      for (const s of shapes) expect(s.closePath).toBe(true);
      g.destroy();
    }
  });
});
