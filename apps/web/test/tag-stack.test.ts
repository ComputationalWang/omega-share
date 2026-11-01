// OME-2118 (design judge on OME-2116, QA OME-2107): by the partition doorway in studio (phone, fitted) and dank-dungeon
// (desktop, from the north) the Dee/Cal/Bea tags piled on one another. Overlapping tags stack, each one readable.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { TAG_OFFSET_Y, TILE_H, TILE_W, setNorth } from "../src/layout";
import { HEAD_H, HEAD_W, stackTags, type TagBox } from "../src/tag-stack";
import { EMOTE_LIFT } from "../src/walk/animator";

const preset = (name: string) => v.parse(RoomLayoutSchema, JSON.parse(readFileSync(new URL(`../../../assets/presets/${name}.json`, import.meta.url), "utf8")));
const H = 20;
const dys = (tags: readonly TagBox[], h: number, maxY?: number): number[] => stackTags(tags, h, maxY).map((p) => p.dy);

afterEach(() => {
  setNorth(false);
});

/** The pairs of tags whose boxes, moved by `dy` (a number, or a placement's dx and dy), overlap. */
function overlaps(tags: readonly TagBox[], dy: readonly (number | { dx: number; dy: number })[], h: number): [number, number][] {
  const out: [number, number][] = [];
  const at = (i: number): { dx: number; dy: number } => {
    const d = dy[i] ?? 0;
    return typeof d === "number" ? { dx: 0, dy: d } : d;
  };
  const top = (i: number): number => (tags[i]?.y ?? 0) + at(i).dy;
  tags.forEach((a, i) => {
    tags.forEach((b, j) => {
      if (j <= i) return;
      const xs = Math.abs(a.x + at(i).dx - b.x - at(j).dx) < (a.w + b.w) / 2;
      const ys = Math.abs(top(i) - top(j)) < h;
      if (xs && ys) out.push([i, j]);
    });
  });
  return out;
}

describe("stackTags", () => {
  test("tags apart stay where they hang", () => {
    expect(dys([{ x: 100, y: 300, w: 40 }, { x: 300, y: 300, w: 40 }, { x: 100, y: 400, w: 40 }], H)).toEqual([0, 0, 0]);
  });

  test("three tags on one spot stack, the first where it hangs, each next one under the last", () => {
    const tags = [{ x: 200, y: 300, w: 40 }, { x: 205, y: 302, w: 44 }, { x: 198, y: 301, w: 40 }];
    const placed = stackTags(tags, H);
    expect(placed[0]?.dy).toBe(0);
    expect(overlaps(tags, placed, H)).toEqual([]);
    expect(Math.max(...placed.map((p) => p.dy))).toBeLessThanOrEqual(2 * (H + 2) + 2);
  });

  test("a tag only moves down, never up over its avatar", () => {
    const tags = [{ x: 200, y: 310, w: 40 }, { x: 210, y: 300, w: 40 }];
    for (const d of dys(tags, H)) expect(d).toBeGreaterThanOrEqual(0);
  });

  // OME-2118 CI (landscape-phone): two members at the front edge; the second tag dropped out of the room window.
  test("a tag that would drop past the bottom stacks up over the one it hits instead", () => {
    const tags = [{ x: 200, y: 560, w: 40 }, { x: 205, y: 562, w: 40 }];
    const placed = stackTags(tags, H, 592);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.forEach((t, i) => {
      expect(t.y + (placed[i]?.dy ?? 0) + H).toBeLessThanOrEqual(592);
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

// OME-2149 (design judge on OME-2122, busy-desktop-1280x800): the Visitor's stacked tag covered Dee's head and the stack
// drifted a cell off its owner. A tag stays off other heads and next to its owner, or wears a leader pip.
describe("stackTags: tags keep off heads and by their owner", () => {
  /** An avatar at `p`, its tag `w` px wide: seated ones' heads sit lower (walk/animator.ts EMOTE_LIFT). */
  const member = (p: { x: number; y: number }, w: number, seated: boolean): TagBox => ({ x: p.x, y: p.y + TAG_OFFSET_Y, w, top: p.y - (seated ? EMOTE_LIFT.sit : EMOTE_LIFT.idle) });
  const box = (t: TagBox, p: { dx: number; dy: number }, h: number) => ({ x0: t.x + p.dx - t.w / 2, x1: t.x + p.dx + t.w / 2, y0: t.y + p.dy, y1: t.y + p.dy + h });
  /** Each tag and the other members' heads it covers. */
  function onHeads(tags: readonly TagBox[], h: number): [number, number][] {
    const placed = stackTags(tags, h);
    const out: [number, number][] = [];
    tags.forEach((t, i) => {
      const b = box(t, placed[i] ?? { dx: 0, dy: 0 }, h);
      tags.forEach((o, j) => {
        if (i === j || o.top === undefined) return;
        if (b.x0 < o.x + HEAD_W / 2 && o.x - HEAD_W / 2 < b.x1 && b.y0 < o.top + HEAD_H && o.top < b.y1) out.push([i, j]);
      });
    });
    return out;
  }
  /** The tag lies within one cell of its owner: sideways of its feet, above its head or below its tag's anchor. */
  const nearOwner = (t: TagBox, p: { dx: number; dy: number }, h: number): boolean => {
    const b = box(t, p, h);
    return Math.abs(p.dx) <= TILE_W / 2 && b.y1 >= (t.top ?? t.y) - TILE_H && b.y0 <= t.y + TILE_H;
  };

  test("a standing tag over a seated neighbour's head moves off it and stays by its owner, no pip", () => {
    const visitor = member({ x: 460, y: 540 }, 46, false);
    const dee = member({ x: 460, y: 590 }, 34, true);
    const tags = [visitor, dee];
    expect(onHeads(tags, H)).toEqual([]);
    const [v] = stackTags(tags, H);
    expect(v?.led).toBe(false);
    expect(nearOwner(visitor, v ?? { dx: 99, dy: 99 }, H)).toBe(true);
  });

  // Every seat sat on and every standing spot stood on, in every preset, from either side; three-letter names and the
  // widest tags, at 1× and at the phone's largest tag scale.
  const presets = ["bar", "cafe", "cinema", "classic", "dank-dungeon", "living", "lounge", "penthouse", "studio"];
  test.each(presets.flatMap((p) => ["south", "north"].flatMap((s) => [40, 160].flatMap((w) => [1, 2.5].map((k) => [p, s, w, k] as const)))))(
    "%s from the %s, %i px tags at %d×: no tag on a head or a tag, each by its owner or led",
    (name, side, w, k) => {
      setNorth(side === "north");
      const room = preset(name);
      const tags = [...seatPoints(room).map((p) => member(p, w * k, true)), ...standingPoints(room).map((p) => member(p, w * k, false))];
      const h = H * k;
      const placed = stackTags(tags, h);
      expect(onHeads(tags, h)).toEqual([]);
      expect(overlaps(tags, placed, h)).toEqual([]);
      tags.forEach((t, i) => {
        const p = placed[i] ?? { dx: 0, dy: 0, led: false };
        expect(p.led).toBe(!nearOwner(t, p, h));
      });
    },
  );
});
