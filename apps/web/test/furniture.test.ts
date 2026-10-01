import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, MAX_ROOM_MEMBERS, RoomLayoutSchema, footprintCells, parseServerMessage, type RoomLayout, type RoomState } from "@omega/shared";
import { FurnitureManifestSchema, layoutOf, sceneOf, seatPoints, standDepth, standingPoints, usesSetG, type Scene } from "../src/furniture";
import { cellCenter } from "../src/layout";

// Furniture and seats from snapshot.room.layout (OME-278, ADR 0021); set (g) art: assets/furniture (OME-261).

const manifest = v.parse(FurnitureManifestSchema, await Bun.file(new URL("../../../assets/furniture/furniture.json", import.meta.url)).json());

/** A layout with set (g) pieces: two sofas, a couch, a wingback and a beanbag (8 seats), a runner, a print, a bookcase and props. */
const SET_G: RoomLayout = v.parse(RoomLayoutSchema, {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "runner", col: 4, row: 4, facing: "ne", variant: 1 },
    { kind: "sofa", col: 2, row: 5, facing: "ne" },
    { kind: "sofa", col: 5, row: 2, facing: "nw", variant: 1 },
    { kind: "couch", col: 3, row: 7, facing: "nw" },
    { kind: "wingback", col: 1, row: 6, facing: "ne" },
    { kind: "beanbag", col: 7, row: 3, facing: "nw" },
    { kind: "frame", col: 3, row: 0, facing: "sw" },
    { kind: "bookshelf", col: 6, row: 0, facing: "sw" },
    { kind: "arclamp", col: 8, row: 8, facing: "sw" },
    { kind: "popcorn", col: 0, row: 9, facing: "se" },
  ],
});

const roomWith = (layout?: RoomLayout): RoomState => ({
  id: "lobby",
  seats: Array.from({ length: 8 }, () => null),
  members: [],
  embed: null,
  playback: null,
  ...(layout === undefined ? {} : { layout }),
});

const keysOf = (s: Scene): string[] => s.sprites.map((x) => x.key);
const sprite = (s: Scene, key: string): Scene["sprites"][number] => {
  const found = s.sprites.find((x) => x.key === key);
  if (found === undefined) throw new Error(`no sprite ${key}`);
  return found;
};

describe("seats come from the layout", () => {
  test("DEFAULT_LAYOUT gives today's eight seats, two rows of four split by an aisle", () => {
    const today = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const;
    expect(seatPoints(DEFAULT_LAYOUT)).toEqual(today.map(([c, r]) => cellCenter(c, r)));
  });

  test("a set (g) layout's seats are its seat pieces' cells, in furniture order", () => {
    const cells = [[2, 5], [3, 5], [5, 2], [5, 3], [3, 7], [3, 8], [1, 6], [7, 3]] as const;
    expect(seatPoints(SET_G)).toEqual(cells.map(([c, r]) => cellCenter(c, r)));
  });
});

describe("layout fallback", () => {
  test("a room without a layout (pre-M4 server) draws DEFAULT_LAYOUT", () => {
    expect(layoutOf(roomWith())).toBe(DEFAULT_LAYOUT);
    expect(layoutOf(null)).toBe(DEFAULT_LAYOUT);
  });

  test("a room with a layout draws that layout", () => {
    expect(layoutOf(roomWith(SET_G))).toBe(SET_G);
  });
});

describe("unknown furniture is rejected at the parse boundary", () => {
  const frame = (kind: string): string =>
    JSON.stringify({ type: "snapshot", self: "a", room: { ...roomWith(), layout: { furniture: [...DEFAULT_LAYOUT.furniture.slice(0, -1), { kind, col: 0, row: 9, facing: "se" }] } } });

  test("a snapshot whose layout holds an unknown kind never reaches the client", () => {
    expect(parseServerMessage(frame("throne"))).toBeNull();
  });

  test("the same snapshot with a known kind parses", () => {
    expect(parseServerMessage(frame("plant"))).not.toBeNull();
  });
});

describe("the set (g) atlas is only needed for set (g) pieces", () => {
  test("DEFAULT_LAYOUT uses only the room's own pieces", () => {
    expect(usesSetG(DEFAULT_LAYOUT)).toBe(false);
  });

  test("a layout with a set (g) piece needs the atlas", () => {
    expect(usesSetG(SET_G)).toBe(true);
    expect(usesSetG({ furniture: [...DEFAULT_LAYOUT.furniture.slice(0, -1), { kind: "monstera", col: 0, row: 9, facing: "se" }] })).toBe(true);
  });
});

describe("scene: DEFAULT_LAYOUT looks like today", () => {
  const scene = sceneOf(DEFAULT_LAYOUT, null);

  test("no furniture sprites: the room's pieces are still the placeholder floor and seat markers", () => {
    expect(scene.sprites).toEqual([]);
  });

  test("every seat has a marker, at its cell, sorted like an avatar standing there", () => {
    expect(scene.seats.map((s) => s.marker)).toEqual(Array.from({ length: 8 }, () => true));
    for (const s of scene.seats) expect(s.z).toBe(standDepth(s.at));
  });

  test("standing spots are today's: the front of the room, filled in order", () => {
    const spots = standingPoints(DEFAULT_LAYOUT);
    expect(spots).toHaveLength(MAX_ROOM_MEMBERS);
    expect(spots.slice(0, 3)).toEqual([cellCenter(4, 9), cellCenter(5, 8), cellCenter(6, 7)]);
    expect(spots[6]).toEqual(cellCenter(6, 9));
  });
});

describe("scene: a set (g) layout", () => {
  const scene = sceneOf(SET_G, manifest);

  test("every sprite is a frame in the atlas, coloured by the piece's variant", () => {
    for (const k of keysOf(scene)) expect(manifest.frames[k]).toBeDefined();
    expect(keysOf(scene)).toContain("furniture/sofa/velvet/ne/back");
    expect(keysOf(scene)).toContain("furniture/sofa/navy/nw/front");
    expect(keysOf(scene)).toContain("furniture/rug/teal/ne/back");
  });

  test("sprites stand on their anchor cell's floor point", () => {
    expect(sprite(scene, "furniture/sofa/velvet/ne/back")).toMatchObject(cellCenter(2, 5));
    expect(sprite(scene, "furniture/bookshelf/wood/sw/back")).toMatchObject(cellCenter(6, 0));
  });

  test("the runner draws with the floor and the print with the walls; neither is depth-sorted with avatars", () => {
    expect(sprite(scene, "furniture/rug/teal/ne/back").layer).toBe("floor");
    expect(sprite(scene, "furniture/frame/dusk/sw/back").layer).toBe("wall");
    expect(sprite(scene, "furniture/sofa/velvet/ne/back").layer).toBe("object");
  });

  test("room-atlas pieces in a set (g) layout are not drawn from the furniture atlas", () => {
    expect(keysOf(scene).some((k) => k.includes("/tv/"))).toBe(false);
  });

  test("only armchair seats get the placeholder marker; set (g) seats are their piece", () => {
    expect(scene.seats.every((s) => !s.marker)).toBe(true);
  });

  test("both sitters on a sofa draw between its back and its front, the near one too", () => {
    const back = sprite(scene, "furniture/sofa/velvet/ne/back").z;
    const front = sprite(scene, "furniture/sofa/velvet/ne/front").z;
    for (const i of [0, 1]) {
      const z = scene.seats[i]?.z ?? NaN;
      expect(z).toBeGreaterThan(back);
      expect(z).toBeLessThan(front);
    }
    // Sorted by its own cell, the near sitter (3,5) would land in front of the backrest.
    expect(standDepth(cellCenter(3, 5))).toBeGreaterThan(front);
  });

  test("a sitter sorts with its own piece, not a neighbour's", () => {
    const wingFront = sprite(scene, "furniture/wingback/ginger/ne/front").z;
    const wingBack = sprite(scene, "furniture/wingback/ginger/ne/back").z;
    const z = scene.seats[6]?.z ?? NaN;
    expect(z).toBeGreaterThan(wingBack);
    expect(z).toBeLessThan(wingFront);
  });

  test("someone standing in front of a piece draws over it, someone behind it under it", () => {
    const lamp = sprite(scene, "furniture/arclamp/brass/sw/back").z;
    expect(standDepth(cellCenter(9, 9))).toBeGreaterThan(lamp);
    expect(standDepth(cellCenter(7, 7))).toBeLessThan(lamp);
  });

  test("z-sort follows the manifest's sort point, then x, then layer", () => {
    // The 2×1 sofa's sort point is its footprint centre, 16 px right and 8 px down of the anchor (manifest sortByDir).
    const a = cellCenter(2, 5);
    const back = sprite(scene, "furniture/sofa/velvet/ne/back").z;
    expect(back).toBeGreaterThan(standDepth({ x: a.x + 15, y: a.y + 8 }));
    expect(back).toBeLessThan(standDepth({ x: a.x + 16, y: a.y + 8 }));
  });

  test("without the atlas yet, the layout's set (g) pieces aren't drawn and nothing breaks", () => {
    const bare = sceneOf(SET_G, null);
    expect(bare.sprites).toEqual([]);
    expect(bare.seats.map((s) => s.at)).toEqual(seatPoints(SET_G));
  });

  test("standing spots keep off solid pieces and seats", () => {
    const blocked = new Set<string>();
    for (const f of SET_G.furniture) {
      if (f.kind === "runner" || f.kind === "frame") continue;
      for (const [c, r] of footprintCells(f)) {
        const p = cellCenter(c, r);
        blocked.add(`${String(p.x)},${String(p.y)}`);
      }
    }
    const spots = standingPoints(SET_G);
    expect(spots).toHaveLength(MAX_ROOM_MEMBERS);
    for (const p of spots) expect(blocked.has(`${String(p.x)},${String(p.y)}`)).toBe(false);
    expect(new Set(spots.map((p) => `${String(p.x)},${String(p.y)}`)).size).toBe(spots.length);
  });
});
