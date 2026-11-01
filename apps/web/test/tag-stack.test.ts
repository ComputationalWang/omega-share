// OME-2118 (design judge on OME-2116, QA OME-2107): by the partition doorway in studio (phone, fitted) and dank-dungeon
// (desktop, from the north) the Dee/Cal/Bea tags piled on one another. Overlapping tags stack, each one readable.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { TAG_OFFSET_Y, setNorth } from "../src/layout";
import { stackTags, type TagBox } from "../src/tag-stack";

const preset = (name: string) => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../../../assets/presets/${name}.json`, import.meta.url), "utf8")));
const H = 20;

afterEach(() => {
  setNorth(false);
});

/** The pairs of tags whose boxes, lifted by `dy`, overlap. */
function overlaps(tags: readonly TagBox[], dy: readonly number[], h: number): [number, number][] {
  const out: [number, number][] = [];
  const top = (i: number): number => (tags[i]?.y ?? 0) + (dy[i] ?? 0);
  tags.forEach((a, i) => {
    tags.forEach((b, j) => {
      if (j <= i) return;
      const xs = Math.abs(a.x - b.x) < (a.w + b.w) / 2;
      const ys = Math.abs(top(i) - top(j)) < h;
      if (xs && ys) out.push([i, j]);
    });
  });
  return out;
}

describe("stackTags", () => {
  test("tags apart stay where they hang", () => {
    expect(stackTags([{ x: 100, y: 300, w: 40 }, { x: 300, y: 300, w: 40 }, { x: 100, y: 400, w: 40 }], H)).toEqual([0, 0, 0]);
  });

  test("three tags on one spot stack, the first where it hangs, each next one under the last", () => {
    const tags = [{ x: 200, y: 300, w: 40 }, { x: 205, y: 302, w: 44 }, { x: 198, y: 301, w: 40 }];
    const dy = stackTags(tags, H);
    expect(dy[0]).toBe(0);
    expect(overlaps(tags, dy, H)).toEqual([]);
    expect(Math.max(...dy)).toBeLessThanOrEqual(2 * (H + 2) + 2);
  });

  test("a tag only moves down, never up over its avatar", () => {
    const tags = [{ x: 200, y: 310, w: 40 }, { x: 210, y: 300, w: 40 }];
    for (const d of stackTags(tags, H)) expect(d).toBeGreaterThanOrEqual(0);
  });

  // OME-2118 CI (landscape-phone): two members at the front edge; the second tag dropped out of the room window.
  test("a tag that would drop past the bottom stacks up over the one it hits instead", () => {
    const tags = [{ x: 200, y: 560, w: 40 }, { x: 205, y: 562, w: 40 }];
    const dy = stackTags(tags, H, 592);
    expect(overlaps(tags, dy, H)).toEqual([]);
    tags.forEach((t, i) => {
      expect(t.y + (dy[i] ?? 0) + H).toBeLessThanOrEqual(592);
    });
  });

  test("the same tags stack the same way whatever their order (a render and a stop agree)", () => {
    const a = { x: 200, y: 300, w: 40 };
    const b = { x: 210, y: 300, w: 40 };
    const [da, db] = stackTags([a, b], H);
    const [db2, da2] = stackTags([b, a], H);
    expect([da2, db2]).toEqual([da, db]);
  });

  // Every seat and standing spot taken, in the two rooms QA caught, from either side, with three-letter names and the
  // widest tag room.css allows (160 px).
  test.each(["studio", "dank-dungeon"].flatMap((p) => ["south", "north"].flatMap((s) => [40, 160].map((w) => [p, s, w] as const))))("%s from the %s, %i px tags: no two tags overlap", (name, side, w) => {
    setNorth(side === "north");
    const room = preset(name);
    const tags = [...seatPoints(room), ...standingPoints(room)].map((p) => ({ x: p.x, y: p.y + TAG_OFFSET_Y, w }));
    expect(overlaps(tags, stackTags(tags, H), H)).toEqual([]);
  });
});
