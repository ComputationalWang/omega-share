// OME-2118 (design judge on OME-2116, QA OME-2107): by the partition doorway in studio (phone, fitted) and dank-dungeon
// (desktop, from the north) the Dee/Cal/Bea tags piled on one another. Overlapping tags stack, each one readable.
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import { RoomLayoutSchema } from "@omega/shared";
import { seatPoints, standingPoints } from "../src/furniture";
import { TAG_OFFSET_Y, cellCenter, setNorth } from "../src/layout";
import { HEAD_H, HEAD_W, createTagStacker, reachOf, screenBoxes, stackTags, wearPlace, type TagBox, type TagPlace } from "../src/tag-stack";
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

  // OME-2518: the others no longer climb over the first; they sit beside the heads, within reach.
  test("three tags on one spot: one over the heads, the others beside them; none overlap, the far ones led", () => {
    const tags = [member({ x: 200, y: 300 }, 40), member({ x: 205, y: 302 }, 44), member({ x: 198, y: 301 }, 40)];
    const placed = stackTags(tags, H);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.forEach((t, i) => {
      const p = placed[i] ?? { dx: 0, dy: 0, led: false };
      expect(p.led).toBe(fromHead(t, p, H) > 12);
      const y = t.y + p.dy + H / 2;
      expect(Math.hypot(Math.max(0, Math.abs(p.dx) - HEAD_W / 2), Math.max(0, t.top - y, y - t.top - HEAD_H))).toBeLessThanOrEqual(reachOf(H));
    });
    expect(tags.filter((t, i) => t.y + (placed[i]?.dy ?? 0) + H <= Math.min(...tags.map((o) => o.top))).length).toBe(1);
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

  // OME-2518 (judge OME-2516): Café on Pixel 7, fitted (labels 2.5×), four on the counter stools and the left table and a
  // viewer standing. The fourth tag, its spots over the head and under the feet taken by a few px, stacked 3 tag heights
  // up the back wall. Spots within one stack step of the head come first, beside the head among them.
  test("in a dense cluster every tag stays within one stack step of its own head", () => {
    const sit = (x: number, py: number): TagBox => ({ x, y: py + TAG_OFFSET_Y, w: 125, top: py - 41 });
    const tags = [sit(815, 1524), sit(847, 1540), sit(687, 1588), sit(751, 1588), { x: 815, y: 1726, w: 125, top: 1656 }];
    const h = 50;
    const places = stackTags(tags, h);
    tags.forEach((t, i) => {
      const y = t.y + (places[i]?.dy ?? NaN) + h / 2;
      const dx = Math.max(0, Math.abs(places[i]?.dx ?? NaN) - HEAD_W / 2);
      expect(Math.hypot(dx, Math.max(0, t.top - y, y - (t.top + HEAD_H))), `tag ${String(i)}`).toBeLessThanOrEqual(reachOf(h));
    });
    expect(overlaps(tags, places, h)).toEqual([]);
    expect(places[3]?.led).toBe(true);
  });
});

// OME-2196 (design judge round 4): in a tight cluster a front avatar's tag stacked over the tags behind it, a cell off
// its owner and nearer someone else; on the phone's cinema a tag sat on the screen art. A tag stays nearest its own
// head, wears a pip when off it, and keeps off the screen.
describe("stackTags: clusters and the screen", () => {
  const centre = (t: TagBox, p: TagPlace, h: number) => ({ x: t.x + p.dx, y: t.y + p.dy + h / 2 });
  /** Whose head (index) is nearest the placed tag's centre; a tie goes to its owner. */
  const nearestHead = (tags: readonly TagBox[], i: number, p: TagPlace, h: number): number => {
    const c = centre(tags[i] ?? tags[0] ?? member({ x: 0, y: 0 }, 0), p, h);
    const d = (t: TagBox) => Math.hypot(t.x - c.x, t.top + HEAD_H / 2 - c.y);
    return tags.reduce((best, t, j) => (d(t) < d(tags[best] ?? t) ? j : best), i);
  };

  // The busy room (e2e busy room, classic): Visitor, Bea, Cal, Dee, Eli, Fay on a 2×3 block of cells.
  const CELLS = [[4, 4], [5, 4], [4, 5], [5, 5], [6, 4], [4, 6]] as const;
  test.each([false, true])("the busy 6-avatar block (north: %p): no two tags overlap, each nearest its own head, led when off it", (north) => {
    setNorth(north);
    const tags = CELLS.map(([c, r], i) => member(cellCenter(c, r), [46, 32, 28, 32, 24, 30][i] ?? 30));
    const placed = stackTags(tags, H);
    expect(overlaps(tags, placed, H)).toEqual([]);
    tags.forEach((t, i) => {
      const p = placed[i] ?? { dx: 0, dy: 0, led: false };
      expect(nearestHead(tags, i, p, H)).toBe(i);
      expect(p.led).toBe(fromHead(t, p, H) > 12);
    });
  });

  // The judge's observer (busy-dpr2-tall) stood in front of the block: no spot by Dee is nearest Dee, and the tag stacked
  // over the heads and tags behind, by the screen. It takes the spot that names Dee best: under the feet.
  test("where no spot is nearest its owner, the tag takes the one nearest by the most: under the feet, not over the heads behind", () => {
    const tags = [...CELLS.map(([c, r], i) => member(cellCenter(c, r), [46, 32, 28, 32, 24, 30][i] ?? 30)), member({ x: cellCenter(5, 5).x - 31, y: cellCenter(5, 5).y + 80 }, 34)];
    const placed = stackTags(tags, H);
    expect(overlaps(tags, placed, H)).toEqual([]);
    const dee = tags[3];
    const p = placed[3];
    if (dee === undefined || p === undefined) throw new Error("no Dee");
    expect(dee.y + p.dy).toBeGreaterThanOrEqual(dee.top + HEAD_H);
    expect(p.led).toBe(true);
  });

  test("a tag whose spot over the head lies on the screen goes off it, by its owner", () => {
    const t = member({ x: 200, y: 300 }, 40);
    const screen = { x0: 150, x1: 260, y0: 160, y1: t.top - 4 };
    const [p] = stackTags([t], H, Infinity, -Infinity, [screen]);
    if (p === undefined) throw new Error("no place");
    const b = { x0: t.x + p.dx - t.w / 2, x1: t.x + p.dx + t.w / 2, y0: t.y + p.dy, y1: t.y + p.dy + H };
    expect(b.x0 < screen.x1 && screen.x0 < b.x1 && b.y0 < screen.y1 && screen.y0 < b.y1).toBe(false);
    expect(nearestHead([t], 0, p, H)).toBe(0);
    expect(p.led).toBe(true);
  });
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

// OME-2317: in the Pixel 7 /conga row a render lands on nearly every frame, and most change only walkers, whose tags aren't
// stacked; stacking the still tags again on each was most of the row's allocation (its GC tail). Equal tags reuse the stack.
describe("createTagStacker", () => {
  const cluster = (): TagBox[] => [0, 3, 6].map((dx) => ({ x: 200 + dx, y: 300, w: 60, top: 300 - EMOTE_LIFT.idle }));
  const screen = { x0: 0, x1: 50, y0: 0, y1: 50 };

  test("equal tags, height, window and screen: the same places, not stacked again", () => {
    const stack = createTagStacker();
    const first = stack(cluster(), H, 600, 0, [screen]);
    expect(first).toEqual(stackTags(cluster(), H, 600, 0, [screen]));
    expect(stack(cluster(), H, 600, 0, [{ ...screen }])).toBe(first);
  });

  test.each([
    ["a tag moved", (t: TagBox[]) => [{ ...t[0], x: 400 } as TagBox, ...t.slice(1)], H, 600, 0, [screen]],
    ["a tag fewer", (t: TagBox[]) => t.slice(1), H, 600, 0, [screen]],
    ["a wider tag", (t: TagBox[]) => [{ ...t[0], w: 90 } as TagBox, ...t.slice(1)], H, 600, 0, [screen]],
    ["a taller tag", (t: TagBox[]) => t, 30, 600, 0, [screen]],
    ["a shorter window", (t: TagBox[]) => t, H, 310, 0, [screen]],
    ["a lower window top", (t: TagBox[]) => t, H, 600, 250, [screen]],
    ["no screen", (t: TagBox[]) => t, H, 600, 0, []],
  ] as const)("%s: stacked again", (_, change, h, maxY, minY, avoid) => {
    const stack = createTagStacker();
    const first = stack(cluster(), H, 600, 0, [screen]);
    const next = stack(change(cluster()), h, maxY, minY, avoid);
    expect(next).not.toBe(first);
    expect(next).toEqual(stackTags(change(cluster()), h, maxY, minY, avoid));
  });
});

// OME-2196: the screen's box (stage px) from its sprites' frames, each drawn from its anchor.
describe("screenBoxes", () => {
  test("each marked sprite's frame, around its anchor; unmarked or unloaded ones give nothing", () => {
    const frames: Record<string, { w: number; h: number; ax: number; ay: number }> = { s: { w: 100, h: 60, ax: 0.5, ay: 0.75 }, o: { w: 10, h: 10, ax: 0, ay: 0 } };
    const sprites = [{ key: "s", x: 200, y: 300, screen: true as const }, { key: "o", x: 0, y: 0 }, { key: "gone", x: 5, y: 5, screen: true as const }];
    expect(screenBoxes(sprites, (k) => frames[k])).toEqual([{ x0: 150, x1: 250, y0: 255, y1: 300 }]);
  });

  // OME-2246 (judge round 7): classic's TV console is one frame, the picture over its anchor and the console's front
  // under it; the front's last px kept the back row's tags off their heads, 165 px up. A wall screen hangs over its anchor.
  test("a screen ends at its anchor: what's under it is the stand's front, not the picture", () => {
    const frames: Record<string, { w: number; h: number; ax: number; ay: number }> = { tv: { w: 162, h: 62, ax: 0.5, ay: 37 / 62 }, wall: { w: 62, h: 70, ax: 0.5, ay: 1.5 } };
    const sprites = [{ key: "tv", x: 480, y: 236, screen: true as const }, { key: "wall", x: 100, y: 200, screen: true as const }];
    expect(screenBoxes(sprites, (k) => frames[k])).toEqual([{ x0: 399, x1: 561, y0: 199, y1: 236 }, { x0: 69, x1: 131, y0: 95, y1: 165 }]);
  });
});
