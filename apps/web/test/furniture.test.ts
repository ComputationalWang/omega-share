import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, MAX_ROOM_MEMBERS, RoomLayoutSchema, footprintCells, parseServerMessage, type RoomLayout, type RoomState } from "@omega/shared";
import { FurnitureManifestSchema, RoomManifestSchema, layoutOf, sceneOf, seatPoints, standDepth, standingPoints, usesSetG, usesV2, type Scene } from "../src/furniture";
import { cellCenter } from "../src/layout";

// Furniture and seats from snapshot.room.layout (OME-278, ADR 0021); set (g) art: assets/furniture (OME-261).

const manifest = v.parse(FurnitureManifestSchema, await Bun.file(new URL("../../../assets/furniture/furniture.json", import.meta.url)).json());
const v2 = v.parse(FurnitureManifestSchema, await Bun.file(new URL("../../../assets/furniture/furniture-v2.json", import.meta.url)).json());
const room = v.parse(RoomManifestSchema, await Bun.file(new URL("../../../assets/room/room.json", import.meta.url)).json());
/** The classic preset: the pre-M4 room (tv, 7×7 rug, eight armchairs, lamp, plant), all room-atlas kinds. */
const CLASSIC: RoomLayout = v.parse(RoomLayoutSchema, await Bun.file(new URL("../../../assets/presets/classic.json", import.meta.url)).json());

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
  const scene = sceneOf(DEFAULT_LAYOUT, []);

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
  const scene = sceneOf(SET_G, [manifest]);

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

  test("of two sitters on one sofa, the nearer one draws over the farther one", () => {
    const far = scene.seats[0]?.z ?? NaN;
    const near = scene.seats[1]?.z ?? NaN;
    expect(near).toBeGreaterThan(far);
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
    const bare = sceneOf(SET_G, []);
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

// OME-1062: the room atlas (assets/room, OME-31) draws the room-atlas kinds, the plank floor and the two back walls.
describe("room atlas", () => {
  const classic = sceneOf(CLASSIC, [], room);
  const at = (s: Scene, key: string, col: number, row: number): Scene["sprites"][number] | undefined =>
    s.sprites.find((x) => x.key === key && x.x === cellCenter(col, row).x && x.y === cellCenter(col, row).y);

  test("the classic room's armchairs are drawn, not markers, and a sitter sits between back and front", () => {
    expect(classic.seats.every((s) => !s.marker)).toBe(true);
    // Seat 0 is the armchair at (1,5) facing ne.
    const back = at(classic, "armchair/ne/back", 1, 5);
    const front = at(classic, "armchair/ne/front", 1, 5);
    expect(back?.layer).toBe("object");
    const z = classic.seats[0]?.z ?? NaN;
    expect(z).toBeGreaterThan(back?.z ?? NaN);
    expect(z).toBeLessThan(front?.z ?? NaN);
  });

  test("the console, lamp and plant are drawn on their cells", () => {
    expect(at(classic, "tv/0", 0, 0)).toBeDefined();
    expect(at(classic, "lamp/0", 9, 0)?.layer).toBe("object");
    expect(at(classic, "plant/0", 0, 9)?.layer).toBe("object");
    expect(standDepth(cellCenter(9, 1))).toBeGreaterThan(at(classic, "lamp/0", 9, 0)?.z ?? NaN);
  });

  test("every floor cell gets one floor tile, and the 7×7 rug is its 9-slice", () => {
    const floor = classic.sprites.filter((x) => x.layer === "floor");
    expect(floor).toHaveLength(100);
    expect(at(classic, "rug/n", 1, 1)?.layer).toBe("floor");
    expect(at(classic, "rug/ne", 4, 1)).toBeDefined();
    expect(at(classic, "rug/e", 7, 1)).toBeDefined();
    expect(at(classic, "rug/nw", 1, 4)).toBeDefined();
    expect(at(classic, "rug/c", 4, 4)).toBeDefined();
    expect(at(classic, "rug/se", 7, 4)).toBeDefined();
    expect(at(classic, "rug/w", 1, 7)).toBeDefined();
    expect(at(classic, "rug/sw", 4, 7)).toBeDefined();
    expect(at(classic, "rug/s", 7, 7)).toBeDefined();
    expect(floor.filter((x) => x.key.startsWith("floor/"))).toHaveLength(100 - 49);
  });

  test("both back walls stand on the back edges, with the corner cap and open ends", () => {
    for (let i = 0; i < 10; i++) {
      expect(classic.sprites.some((x) => x.key.startsWith("wall/l/") && x.layer === "wall" && x.x === cellCenter(0, i).x && x.y === cellCenter(0, i).y)).toBe(true);
      expect(classic.sprites.some((x) => x.key.startsWith("wall/r/") && x.layer === "wall" && x.x === cellCenter(i, 0).x && x.y === cellCenter(i, 0).y)).toBe(true);
    }
    expect(at(classic, "wall/corner", 0, 0)).toBeDefined();
    expect(at(classic, "wall/l/end", 0, 9)).toBeDefined();
    expect(at(classic, "wall/r/end", 9, 0)).toBeDefined();
    // The atlas's suggested walls: a window on the left, a poster on the right.
    expect(keysOf(classic)).toContain("wall/l/window0");
    expect(keysOf(classic)).toContain("wall/r/poster0");
  });

  test("a set (g) room gets the floor and walls too; a wall with a print hangs it on plain segments, drawn after them", () => {
    const g = sceneOf(SET_G, [manifest], room);
    const keys = keysOf(g);
    // The print hangs on the right wall: no poster there, the left wall keeps its window.
    expect(keys.filter((k) => k.startsWith("wall/r/") && k !== "wall/r/end").every((k) => k === "wall/r/plain")).toBe(true);
    expect(keys).toContain("wall/l/window0");
    expect(keys.indexOf("furniture/frame/dusk/sw/back")).toBeGreaterThan(keys.lastIndexOf("wall/r/plain"));
    // The runner lies on the planks, not under them.
    expect(keys.indexOf("furniture/rug/teal/ne/back")).toBeGreaterThan(keys.lastIndexOf("floor/0"));
    expect(keys).toContain("tv/0");
  });

  test("without the room atlas, the classic room keeps its placeholder markers and draws nothing", () => {
    const bare = sceneOf(CLASSIC, [], null);
    expect(bare.sprites).toEqual([]);
    expect(bare.seats.every((s) => s.marker)).toBe(true);
  });
});

// OME-1113: catalogue v2 (assets/furniture/furniture-v2.json, OME-1103) is a second lazy sheet, read the same way as set (g).
/** Every v2 seat in every facing: floor cushions ne nw se sw (seats 0–3), then benches ne and nw (4–7). */
const V2_SEATS: RoomLayout = v.parse(RoomLayoutSchema, {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "floorcushion", col: 2, row: 5, facing: "ne" },
    { kind: "floorcushion", col: 5, row: 2, facing: "nw", variant: 1 },
    { kind: "floorcushion", col: 3, row: 7, facing: "se" },
    { kind: "floorcushion", col: 7, row: 3, facing: "sw" },
    { kind: "bench", col: 5, row: 6, facing: "ne" },
    { kind: "bench", col: 8, row: 5, facing: "nw", variant: 1 },
    { kind: "garland", col: 4, row: 0, facing: "sw" },
    { kind: "garland", col: 5, row: 0, facing: "sw", variant: 1 },
    { kind: "wallshelf", col: 0, row: 4, facing: "se" },
    { kind: "turntable", col: 0, row: 8, facing: "se" },
    { kind: "speaker", col: 1, row: 9, facing: "se" },
    { kind: "cat", col: 9, row: 9, facing: "sw", variant: 1 },
  ],
});
/** Benches facing se and sw (seats 0–3), with four cushions to make eight seats. */
const V2_BENCHES: RoomLayout = v.parse(RoomLayoutSchema, {
  furniture: [
    { kind: "tv", col: 0, row: 0, facing: "se" },
    { kind: "bench", col: 2, row: 5, facing: "se" },
    { kind: "bench", col: 5, row: 2, facing: "sw" },
    { kind: "floorcushion", col: 4, row: 7, facing: "ne" },
    { kind: "floorcushion", col: 7, row: 4, facing: "nw" },
    { kind: "floorcushion", col: 6, row: 8, facing: "se" },
    { kind: "floorcushion", col: 8, row: 6, facing: "sw" },
  ],
});

describe("catalogue v2", () => {
  test("each sheet loads only for its own pieces", () => {
    expect(usesV2(DEFAULT_LAYOUT)).toBe(false);
    expect(usesV2(SET_G)).toBe(false);
    expect(usesV2(V2_SEATS)).toBe(true);
    expect(usesSetG(V2_SEATS)).toBe(false);
    expect(usesSetG({ furniture: [...V2_SEATS.furniture, { kind: "monstera", col: 9, row: 0, facing: "sw" }] })).toBe(true);
  });

  test("v2 pieces draw from the v2 sheet, coloured by variant, on their anchor cell", () => {
    const s = sceneOf(V2_SEATS, [manifest, v2]);
    for (const k of keysOf(s)) expect(v2.frames[k]).toBeDefined();
    expect(sprite(s, "furniture/floorcushion/teal/nw/back")).toMatchObject(cellCenter(5, 2));
    expect(sprite(s, "furniture/cat/charcoal/sw/back").layer).toBe("object");
    expect(sprite(s, "furniture/wallshelf/wood/se/back").layer).toBe("wall");
  });

  test("with only set (g) loaded, v2 pieces wait and their seats still work", () => {
    const s = sceneOf(V2_SEATS, [manifest]);
    expect(s.sprites).toEqual([]);
    expect(s.seats.map((x) => x.at)).toEqual(seatPoints(V2_SEATS));
  });

  test("a sitter on a floor cushion or a bench draws over its back and under its front, in all four facings", () => {
    const cases = [
      [V2_SEATS, 0, "floorcushion/mustard/ne"],
      [V2_SEATS, 1, "floorcushion/teal/nw"],
      [V2_SEATS, 2, "floorcushion/mustard/se"],
      [V2_SEATS, 3, "floorcushion/mustard/sw"],
      [V2_SEATS, 4, "bench/teal/ne"],
      [V2_SEATS, 5, "bench/teal/ne"],
      [V2_SEATS, 6, "bench/pink/nw"],
      [V2_SEATS, 7, "bench/pink/nw"],
      [V2_BENCHES, 0, "bench/teal/se"],
      [V2_BENCHES, 1, "bench/teal/se"],
      [V2_BENCHES, 2, "bench/teal/sw"],
      [V2_BENCHES, 3, "bench/teal/sw"],
    ] as const;
    for (const [layout, i, piece] of cases) {
      const s = sceneOf(layout, [v2]);
      const z = s.seats[i]?.z ?? NaN;
      expect(z).toBeGreaterThan(sprite(s, `furniture/${piece}/back`).z);
      const front = s.sprites.find((x) => x.key === `furniture/${piece}/front`);
      if (front !== undefined) expect(z).toBeLessThan(front.z);
    }
  });

  test("garlands on neighbouring segments hang on plain wall, so their strings join up", () => {
    const keys = keysOf(sceneOf(V2_SEATS, [v2], room));
    expect(keys.filter((k) => k.startsWith("wall/r/") && k !== "wall/r/end").every((k) => k === "wall/r/plain")).toBe(true);
    expect(keys.filter((k) => k.startsWith("wall/l/") && k !== "wall/l/end").every((k) => k === "wall/l/plain")).toBe(true);
    const a = sprite(sceneOf(V2_SEATS, [v2]), "furniture/garland/warm/sw/back");
    const b = sprite(sceneOf(V2_SEATS, [v2]), "furniture/garland/party/sw/back");
    expect([b.x - a.x, b.y - a.y]).toEqual([cellCenter(5, 0).x - cellCenter(4, 0).x, cellCenter(5, 0).y - cellCenter(4, 0).y]);
  });
});
