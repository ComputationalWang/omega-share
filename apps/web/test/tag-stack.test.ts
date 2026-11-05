// OME-2118 (design judge on OME-2116, QA OME-2107): by the partition doorway in studio (phone, fitted) and dank-dungeon
// (desktop, from the north) the Dee/Cal/Bea tags piled on one another. Overlapping tags stack, each one readable.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { TAG_OFFSET_Y, setNorth } from "../src/layout";
import { HEAD_H, HEAD_W, stackTags, wearPlace, type TagBox, type TagPlace } from "../src/tag-stack";
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

/** An avatar at `p`, its tag `w` px wide: seated ones' heads sit lower (walk/animator.ts EMOTE_LIFT). */
const member = (p: { x: number; y: number }, w: number, seated = false): TagBox => ({ x: p.x, y: p.y + TAG_OFFSET_Y, w, top: p.y - (seated ? EMOTE_LIFT.sit : EMOTE_LIFT.idle) });
/** How far (stage px) a placed tag lies from its owner's head; Infinity if it isn't over the head's width. */
function fromHead(t: TagBox, p: { dx: number; dy: number }, h: number): number {
  const [x0, x1, y0] = [t.x + p.dx - t.w / 2, t.x + p.dx + t.w / 2, t.y + p.dy];
  if (x1 < t.x - HEAD_W / 2 || t.x + HEAD_W / 2 < x0) return Infinity;
  return Math.max(0, t.top - (y0 + h), y0 - (t.top + HEAD_H));
}

describe("stackTags", () => {
  // OME-2172 (design judge round 3): tags hung under the feet, a cell from the head they name.
  test.each([false, true])("a lone tag (seated: %p) sits just above its owner's head, off it, no pip", (seated) => {
    const t = member({ x: 200, y: 300 }, 40, seated);
    const [p] = stackTags([t], H);
    if (p === undefined) throw new Error("no place");
    expect(t.y + p.dy + H).toBeLessThanOrEqual(t.top);
    expect(fromHead(t, p, H)).toBeLessThanOrEqual(12);
    expect(p).toMatchObject({ dx: 0, led: false });
  });

  test("tags apart each sit over their own head", () => {
    const tags = [member({ x: 100, y: 300 }, 40), member({ x: 300, y: 300 }, 40), member({ x: 100, y: 400 }, 40)];
    expect(dys(tags, H)).toEqual(tags.map((t) => t.top - 2 - H - t.y));
  });

  test("three tags on one spot stack upward: none overlap, each above the heads, the far ones led", () => {
    const tags = [member({ x: 200, y: 300 }, 40), member({ x: 205, y: 302 }, 44), member({ x: 198, y: 301 }, 40)];
    const placed = stackTags(tags, H);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.forEach((t, i) => {
      const p = placed[i] ?? { dx: 0, dy: 0, led: false };
      expect(t.y + p.dy + H).toBeLessThanOrEqual(Math.min(...tags.map((o) => o.top)));
      expect(p.led).toBe(fromHead(t, p, H) > 12);
    });
  });

  // OME-2118 CI (landscape-phone): two members at the front edge; the second tag dropped out of the room window.
  test("tags by the window's bottom stay inside it", () => {
    const tags = [member({ x: 200, y: 550 }, 40), member({ x: 205, y: 552 }, 40)];
    const placed = stackTags(tags, H, 592);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.forEach((t, i) => {
      expect(t.y + (placed[i]?.dy ?? 0) + H).toBeLessThanOrEqual(592);
    });
  });

  test("a tag whose spot over the head lies past the window's top hangs under the feet, led", () => {
    const t = member({ x: 200, y: 300 }, 40);
    const [p] = stackTags([t], H, Infinity, 260);
    if (p === undefined) throw new Error("no place");
    expect(t.y + p.dy).toBeGreaterThanOrEqual(260);
    expect(t.y + p.dy).toBeGreaterThanOrEqual(t.top + HEAD_H);
    expect(p.led).toBe(true);
  });

  test("the same tags stack the same way whatever their order (a render and a stop agree)", () => {
    const a = member({ x: 200, y: 300 }, 40);
    const b = member({ x: 210, y: 300 }, 40);
    const [da, db] = stackTags([a, b], H);
    const [db2, da2] = stackTags([b, a], H);
    expect([da2, db2]).toEqual([da, db]);
  });

  // Every seat and standing spot taken, in the two rooms QA caught, from either side, with three-letter names and the
  // widest tag room.css allows (160 px).
  test.each(["studio", "dank-dungeon"].flatMap((p) => ["south", "north"].flatMap((s) => [40, 160].map((w) => [p, s, w] as const))))("%s from the %s, %i px tags: no two tags overlap", (name, side, w) => {
    setNorth(side === "north");
    const room = preset(name);
    const tags = [...seatPoints(room), ...standingPoints(room)].map((p) => member(p, w));
    expect(overlaps(tags, stackTags(tags, H), H)).toEqual([]);
  });
});

// OME-2149 (design judge on OME-2122, busy-desktop-1280x800): the Visitor's stacked tag covered Dee's head and the stack
// drifted a cell off its owner. A tag stays off other heads and next to its owner, or wears a leader pip.
describe("stackTags: tags keep off heads and by their owner", () => {
  const box = (t: TagBox, p: { dx: number; dy: number }, h: number) => ({ x0: t.x + p.dx - t.w / 2, x1: t.x + p.dx + t.w / 2, y0: t.y + p.dy, y1: t.y + p.dy + h });
  /** Each tag and the heads it covers, its owner's included (OME-2172). */
  function onHeads(tags: readonly TagBox[], h: number): [number, number][] {
    const placed = stackTags(tags, h);
    const out: [number, number][] = [];
    tags.forEach((t, i) => {
      const b = box(t, placed[i] ?? { dx: 0, dy: 0 }, h);
      tags.forEach((o, j) => {
        if (b.x0 < o.x + HEAD_W / 2 && o.x - HEAD_W / 2 < b.x1 && b.y0 < o.top + HEAD_H && o.top < b.y1) out.push([i, j]);
      });
    });
    return out;
  }
  /** The tag lies within 12 px of its owner's head (OME-2172 acceptance). */
  const nearOwner = (t: TagBox, p: { dx: number; dy: number }, h: number): boolean => fromHead(t, p, h) <= 12;

  test("a standing tag over a seated neighbour's head moves off it and stays by its owner, no pip", () => {
    const visitor = member({ x: 460, y: 540 }, 46, false);
    const dee = member({ x: 460, y: 590 }, 34, true);
    const tags = [visitor, dee];
    expect(onHeads(tags, H)).toEqual([]);
    const [v] = stackTags(tags, H);
    expect(v?.led).toBe(false);
    expect(nearOwner(visitor, v ?? { dx: 99, dy: 99 }, H)).toBe(true);
  });

  // OME-2149 CI (landscape-phone 863×360): the phone window is 90 px tall, so the spot above a neighbour-blocked
  // owner's head lay past its top and the tag left the window. A spot outside the window is no spot.
  test("a tag never takes a spot by its owner that lies past the window's top", () => {
    const tags = [member({ x: 448, y: 454 }, 93, false), member({ x: 512, y: 454 }, 93, false)];
    const [minY, maxY] = [380, 454 + TAG_OFFSET_Y + H + 5];
    const placed = stackTags(tags, H, maxY, minY);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.forEach((t, i) => {
      const y = t.y + (placed[i]?.dy ?? 0);
      expect(y).toBeGreaterThanOrEqual(minY);
      expect(y + H).toBeLessThanOrEqual(maxY);
    });
  });

  // OME-2170 CI (320×640, the keys in a row): a 76 px phone window; the front tag hung 7 px past its bottom, on the zoom
  // key under it, and above the head was past the top. A tag that starts in the window ends in it.
  test("a tag whose owner is in a short window keeps in it; one whose owner is below the window stays out with them", () => {
    const tags = [member({ x: 448, y: 444 }, 40, false), member({ x: 512, y: 444 }, 29, false), member({ x: 300, y: 600 }, 40, false)];
    const [minY, maxY] = [391, 467];
    const placed = stackTags(tags, H, maxY, minY);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.slice(0, 2).forEach((t, i) => {
      expect(t.y + (placed[i]?.dy ?? 0) + H).toBeLessThanOrEqual(maxY);
    });
    expect((tags[2]?.y ?? 0) + (placed[2]?.dy ?? 0)).toBeGreaterThan(maxY);
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

// OME-2213: a walker's tag gets the same place every walk frame, and a render's restack mostly the same places again;
// re-writing their margins and classes cost the /conga row its headroom. A place is worn once.
describe("wearPlace", () => {
  const fake = () => {
    const writes: string[] = [];
    const style = {
      set marginLeft(v: string) {
        writes.push(`left ${v}`);
      },
      set marginTop(v: string) {
        writes.push(`top ${v}`);
      },
    };
    const classList = {
      toggle: (c: string, on: boolean) => {
        writes.push(`${c} ${String(on)}`);
        return on;
      },
    };
    return { e: { style, classList }, writes };
  };

  test("writes a place's margins and classes once, and again only for a new place", () => {
    const { e, writes } = fake();
    const worn = new WeakMap<object, TagPlace>();
    const over: TagPlace = { dx: 0, dy: -40, led: false };
    wearPlace(e, over, worn, true);
    expect(writes).toEqual(["left 0px", "top -40px", "is-led false", "is-above true"]);
    wearPlace(e, over, worn, true);
    expect(writes).toHaveLength(4);
    wearPlace(e, { dx: 5, dy: 8, led: true }, worn, true);
    expect(writes.slice(4)).toEqual(["left 5px", "top 8px", "is-led true", "is-above false"]);
  });

  test("a restack's equal place, a new object, writes nothing", () => {
    const { e, writes } = fake();
    const worn = new WeakMap<object, TagPlace>();
    wearPlace(e, { dx: 3, dy: -40, led: true }, worn, true);
    wearPlace(e, { dx: 3, dy: -40, led: true }, worn, true);
    expect(writes).toHaveLength(4);
  });

  test("a hit pad wears only the margins", () => {
    const { e, writes } = fake();
    wearPlace(e, { dx: 1, dy: 2, led: true }, new WeakMap(), false);
    expect(writes).toEqual(["left 1px", "top 2px"]);
  });
});
