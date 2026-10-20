import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, MAX_ROOM_MEMBERS, RoomLayoutSchema, footprintCells, parseServerMessage, type RoomLayout, type RoomState } from "@omega/shared";
import { FurnitureManifestSchema, RoomManifestSchema, doorAt, layoutKey, layoutOf, piecesInUse, sceneOf, seatPoints, standDepth, standingPoints, usesSetG, usesV2, usesV4, type Scene } from "../src/furniture";
import { cellCenter } from "../src/layout";
import { cellOf } from "../src/walk/path";

// Furniture and seats from snapshot.room.layout (OME-278, ADR 0021); set (g) art: assets/furniture (OME-261).

const manifest = v.parse(FurnitureManifestSchema, await Bun.file(new URL("../../../assets/furniture/furniture.json", import.meta.url)).json());
const v2 = v.parse(FurnitureManifestSchema, await Bun.file(new URL("../../../assets/furniture/furniture-v2.json", import.meta.url)).json());
const v4 = v.parse(FurnitureManifestSchema, await Bun.file(new URL("../../../assets/furniture/furniture-v4.json", import.meta.url)).json());
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
    { kind: "garland", col: 3, row: 0, facing: "sw", variant: 1 },
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
  test("both sheets share the layer indices sceneOf reads from whichever loaded first", () => {
    expect(v2.meta.omega.layers).toEqual(manifest.meta.omega.layers);
  });

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
    expect([b.x - a.x, b.y - a.y]).toEqual([cellCenter(3, 0).x - cellCenter(4, 0).x, cellCenter(3, 0).y - cellCenter(4, 0).y]);
  });
});

// OME-1407: arcade, turntable, aquarium and neon sign play their "in use" loop while someone stands at their front.
describe("piecesInUse", () => {
  const cells = (...cs: [number, number][]): Set<number> => new Set(cs.map(([c, r]) => cellOf(c, r)));
  test("a teleport pad (OME-1548) shows its active frame while someone stands on its cell", () => {
    const l: RoomLayout = { furniture: [{ kind: "pad", col: 3, row: 3, facing: "se" }, { kind: "pad", col: 6, row: 6, facing: "se" }] };
    expect(piecesInUse(l, cells([3, 3]), false)).toEqual(new Set([0]));
    expect(piecesInUse(l, cells([6, 6]), false)).toEqual(new Set([1]));
    expect(piecesInUse(l, cells([4, 3]), false)).toEqual(new Set());
  });
  // Not parsed (no seats; and the catalogue only lets these pieces face the camera, but the rule holds for every facing).
  const arcade = (facing: "ne" | "nw" | "se" | "sw", col = 4, row = 4): RoomLayout => ({ furniture: [{ kind: "arcade", col, row, facing }] });

  test("each facing: only the cell in front of the piece counts", () => {
    expect(piecesInUse(arcade("se"), cells([5, 4]), false)).toEqual(new Set([0]));
    expect(piecesInUse(arcade("sw"), cells([4, 5]), false)).toEqual(new Set([0]));
    expect(piecesInUse(arcade("ne"), cells([4, 3]), false)).toEqual(new Set([0]));
    expect(piecesInUse(arcade("nw"), cells([3, 4]), false)).toEqual(new Set([0]));
    // Beside or behind it: not in use.
    expect(piecesInUse(arcade("se"), cells([3, 4], [4, 3], [4, 5]), false)).toEqual(new Set());
    expect(piecesInUse(arcade("sw"), cells([5, 4], [4, 3], [3, 4]), false)).toEqual(new Set());
  });

  test("a front cell off the floor never aliases a cell on it", () => {
    // Facing ne at row 0, the front would be (4, -1): as a cell number that is (3, 9).
    expect(piecesInUse(arcade("ne", 4, 0), cells([3, 9]), false)).toEqual(new Set());
    expect(piecesInUse(arcade("se", 9, 2), cells([0, 2]), false)).toEqual(new Set());
  });

  test("a wall piece's front is the floor cell under it on its wall", () => {
    const l: RoomLayout = ({
      furniture: [
        { kind: "tv", col: 0, row: 0, facing: "se" },
        { kind: "neonsign", col: 4, row: 0, facing: "sw" },
        { kind: "neonsign", col: 0, row: 3, facing: "se", variant: 1 },
      ],
    });
    expect(piecesInUse(l, cells([4, 0]), false)).toEqual(new Set([1]));
    expect(piecesInUse(l, cells([0, 3]), false)).toEqual(new Set([2]));
    expect(piecesInUse(l, cells([4, 1], [1, 3]), false)).toEqual(new Set());
  });

  test("only the four pieces with a loop; the neon sign hums whenever a video plays", () => {
    const l: RoomLayout = ({
      furniture: [
        { kind: "tv", col: 0, row: 0, facing: "se" },
        { kind: "turntable", col: 2, row: 2, facing: "se" },
        { kind: "aquarium", col: 2, row: 5, facing: "sw" },
        { kind: "speaker", col: 6, row: 6, facing: "se" },
        { kind: "neonsign", col: 4, row: 0, facing: "sw" },
      ],
    });
    expect(piecesInUse(l, cells([3, 2], [2, 6], [7, 6]), false)).toEqual(new Set([1, 2]));
    expect(piecesInUse(l, cells(), true)).toEqual(new Set([4]));
    expect(piecesInUse(l, cells([3, 2]), true)).toEqual(new Set([1, 4]));
  });
});

describe("sceneOf: in-use loops (OME-1407)", () => {
  const l: RoomLayout = ({
    furniture: [
      { kind: "tv", col: 0, row: 0, facing: "se" },
      { kind: "arcade", col: 2, row: 2, facing: "se" },
      { kind: "neonsign", col: 0, row: 3, facing: "se", variant: 1 },
      { kind: "speaker", col: 6, row: 6, facing: "se" },
    ],
  });
  const scene = sceneOf(l, [v2]);

  test("a piece with a loop carries its frames, frame time and furniture index; others none", () => {
    expect(sprite(scene, "furniture/arcade/night/se/back").use).toEqual({ piece: 1, frames: ["furniture/arcade/night/use/se/0", "furniture/arcade/night/use/se/1", "furniture/arcade/night/use/se/2"], ms: 160 });
    expect(sprite(scene, "furniture/neonsign/teal/se/back").use).toEqual({ piece: 2, frames: ["furniture/neonsign/teal/use/se/0", "furniture/neonsign/teal/use/se/1", "furniture/neonsign/teal/use/se/2"], ms: 140 });
    expect(sprite(scene, "furniture/speaker/wood/se/back").use).toBeUndefined();
  });

  test("every loop frame is in the v2 sheet", () => {
    for (const s of scene.sprites) for (const k of s.use?.frames ?? []) expect(v2.frames[k]).toBeDefined();
  });
});

// OME-1520: the cat's back frame carries what it needs to wander: its home cell, walk and sit frames, and the empty bed.
describe("sceneOf: the wandering cat (OME-1520)", () => {
  const l: RoomLayout = {
    furniture: [
      { kind: "tv", col: 0, row: 0, facing: "se" },
      { kind: "speaker", col: 6, row: 6, facing: "se" },
      { kind: "cat", col: 4, row: 7, facing: "sw", variant: 1 },
    ],
  };
  const scene = sceneOf(l, [v2]);

  test("the cat carries its piece index, home cell and frames; other pieces don't", () => {
    const walk = (dir: string): string[] => [0, 1, 2, 3].map((n) => `furniture/cat/charcoal/walk/${dir}/${String(n)}`);
    expect(sprite(scene, "furniture/cat/charcoal/sw/back").walker).toEqual({
      piece: 2,
      home: cellOf(4, 7),
      walk: { se: walk("se"), sw: walk("sw") },
      sit: { se: "furniture/cat/charcoal/sit/se", sw: "furniture/cat/charcoal/sit/sw" },
      bed: "furniture/cat/charcoal/bed/sw",
      ms: 150,
    });
    expect(sprite(scene, "furniture/speaker/wood/se/back").walker).toBeUndefined();
  });

  test("every cat frame is in the v2 sheet", () => {
    const w = sprite(scene, "furniture/cat/charcoal/sw/back").walker;
    for (const k of [...(w?.walk.se ?? []), ...(w?.walk.sw ?? []), w?.sit.se, w?.sit.sw, w?.bed]) expect(k === undefined ? undefined : v2.frames[k]).toBeDefined();
  });
});

// OME-1425: a door opens while anyone stands in front of it, and my arrival there offers the way through.
describe("doors (OME-1425)", () => {
  const cells = (...cs: [number, number][]): Set<number> => new Set(cs.map(([c, r]) => cellOf(c, r)));
  const door = (col: number, row: number, facing: "se" | "sw", target: string): RoomLayout["furniture"][number] => ({ kind: "door", col, row, facing, target });
  const l: RoomLayout = { furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }, door(0, 3, "se", "other-room"), door(5, 0, "sw", "third-room")] };

  test("piecesInUse: a door is in use while someone stands on the cell in front of it", () => {
    expect(piecesInUse(l, cells([1, 3]), false)).toEqual(new Set([1]));
    expect(piecesInUse(l, cells([5, 1]), false)).toEqual(new Set([2]));
    expect(piecesInUse(l, cells([1, 3], [5, 1]), false)).toEqual(new Set([1, 2]));
    expect(piecesInUse(l, cells([0, 4], [4, 0]), false)).toEqual(new Set());
    expect(piecesInUse(l, cells(), true)).toEqual(new Set());
  });

  test("doorAt: the front cell gives the door's room, any other cell none", () => {
    expect(doorAt(l, 1, 3)).toBe("other-room");
    expect(doorAt(l, 5, 1)).toBe("third-room");
    expect(doorAt(l, 0, 3)).toBeNull();
    expect(doorAt(l, 1, 4)).toBeNull();
    expect(doorAt(DEFAULT_LAYOUT, 1, 3)).toBeNull();
  });

  test("sceneOf: the door's back frame carries a one-frame open loop (its open frame, drawn while in use)", () => {
    const scene = sceneOf(l, [v2]);
    const s = sprite(scene, "furniture/door/wood/se/back");
    expect(s.use?.piece).toBe(1);
    expect(s.use?.frames).toEqual(["furniture/door/wood/open/se"]);
    expect(v2.frames["furniture/door/wood/open/se"]).toBeDefined();
    expect(sprite(scene, "furniture/door/wood/sw/back").use?.frames).toEqual(["furniture/door/wood/open/sw"]);
  });

  test("a layout key tells two doors apart by their rooms", () => {
    expect(layoutKey({ furniture: [door(0, 3, "se", "elsewhere")] })).not.toBe(layoutKey({ furniture: [door(0, 3, "se", "other-room")] }));
  });

  test("the door draws from the v2 sheet", () => {
    expect(usesV2(l)).toBe(true);
    expect(usesSetG(l)).toBe(false); // the tv is a room-atlas piece: a door needs no set (g)
  });
});

// OME-1439: batch 6 (OME-1437 art, its own lazy sheet) and its three "in use" triggers.
describe("batch 6: hammock, stool, bar counter, piano, fireplace", () => {
  const cells = (...cs: [number, number][]): Set<number> => new Set(cs.map(([c, r]) => cellOf(c, r)));
  const l: RoomLayout = {
    furniture: [
      { kind: "tv", col: 0, row: 0, facing: "se" },
      { kind: "hammock", col: 4, row: 7, facing: "ne" },
      { kind: "piano", col: 1, row: 0, facing: "sw" },
      { kind: "fireplace", col: 7, row: 0, facing: "sw" },
      { kind: "stool", col: 3, row: 1, facing: "ne", variant: 1 },
      { kind: "barcounter", col: 0, row: 3, facing: "se" },
      { kind: "piano", col: 0, row: 6, facing: "se", variant: 1 },
    ],
  };

  test("only these pieces load the batch 6 sheet, and they load no other", () => {
    expect(usesV4(l)).toBe(true);
    expect(usesV4(V2_SEATS)).toBe(false);
    expect(usesV4(DEFAULT_LAYOUT)).toBe(false);
    const only6: RoomLayout = { furniture: l.furniture.filter((f) => f.kind !== "tv") };
    expect(usesV2(only6)).toBe(false);
    expect(usesSetG(only6)).toBe(false);
  });

  test("they draw from the batch 6 sheet, coloured by variant; the hammock, piano and fireplace carry their loops", () => {
    const s = sceneOf(l, [manifest, v2, v4]);
    for (const k of keysOf(s).filter((k) => k.startsWith("furniture/"))) expect(v4.frames[k]).toBeDefined();
    for (const x of s.sprites) for (const k of x.use?.frames ?? []) expect(v4.frames[k]).toBeDefined();
    expect(sprite(s, "furniture/stool/teal/ne/back")).toMatchObject(cellCenter(3, 1));
    expect(sprite(s, "furniture/hammock/rust/ne/back").use).toMatchObject({ piece: 1, ms: 260 });
    expect(sprite(s, "furniture/piano/charcoal/se/back").use?.frames).toHaveLength(2);
    expect(sprite(s, "furniture/fireplace/stone/sw/back").use?.ms).toBe(120);
    expect(sprite(s, "furniture/barcounter/wood/se/back").use).toBeUndefined();
  });

  test("the hammock sways while someone sits in it (either seat), not when someone stands in front", () => {
    expect(piecesInUse(l, cells(), false, cells([4, 7]))).toEqual(new Set([1]));
    expect(piecesInUse(l, cells(), false, cells([5, 7]))).toEqual(new Set([1]));
    expect(piecesInUse(l, cells([4, 6], [5, 6]), false, cells())).toEqual(new Set());
    // Sitting on a stool moves nothing.
    expect(piecesInUse(l, cells(), false, cells([3, 1]))).toEqual(new Set());
  });

  test("the piano plays while someone stands at its front, on either footprint cell", () => {
    expect(piecesInUse(l, cells([1, 1]), false)).toEqual(new Set([2]));
    expect(piecesInUse(l, cells([2, 1]), false)).toEqual(new Set([2]));
    // Turned against the left wall: its front is +col of both cells.
    expect(piecesInUse(l, cells([1, 7]), false)).toEqual(new Set([6]));
    expect(piecesInUse(l, cells([3, 0], [2, 2]), false)).toEqual(new Set());
  });

  test("the fireplace burns while a video plays, and only then", () => {
    expect(piecesInUse(l, cells([7, 1]), false)).toEqual(new Set());
    expect(piecesInUse(l, cells(), true)).toEqual(new Set([3]));
  });
});
