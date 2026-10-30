import { afterEach, describe, expect, test } from "bun:test";
import * as v from "valibot";
import { FLOOR_CELLS, RoomLayoutSchema, type RoomLayout } from "@omega/shared";
import { FurnitureManifestSchema, RoomManifestSchema, sceneOf, usesBack, viewVerdict, type Scene } from "../src/furniture";
import { cellCenter, isNorth, setNorth } from "../src/layout";
import { stepCell } from "../src/intents";
import { cellAt, cellOf, centerOf } from "../src/walk/path";
import { createWalks, emptyPose } from "../src/walk/walks";

// OME-1961: a viewer in the bedroom sees the room from the north. Cell (c, r) is drawn at (9 - c, 9 - r), a point
// reflection of the screen (x → 960 - x, y → 760 - y); facings turn se <-> nw, sw <-> ne; pieces come from furniture-back.

const load = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const sheets = await Promise.all(["furniture", "furniture-v2", "furniture-v4", "furniture-v5", "furniture-v6", "furniture-v7"].map(async (n) => v.parse(FurnitureManifestSchema, await load(`furniture/${n}.json`))));
const back = v.parse(FurnitureManifestSchema, await load("furniture/furniture-back.json"));
const room = v.parse(RoomManifestSchema, await load("room/room.json"));
const preset = v.parse(v.object({ shell: v.optional(v.literal("dungeon")), furniture: v.array(v.unknown()) }), await load("presets/dank-dungeon.json"));
const dungeon: RoomLayout = v.parse(RoomLayoutSchema, { furniture: preset.furniture, shell: preset.shell });

afterEach(() => {
  setNorth(false);
});

const at = (s: Scene, key: string): { x: number; y: number; layer: string }[] => s.sprites.filter((x) => x.key === key).map((x) => ({ x: x.x, y: x.y, layer: x.layer }));

describe("the north projection", () => {
  test("every cell round-trips, and the screen is a point reflection of the south view", () => {
    const south = Array.from({ length: FLOOR_CELLS * FLOOR_CELLS }, (_, i) => cellCenter(Math.floor(i / FLOOR_CELLS), i % FLOOR_CELLS));
    setNorth(true);
    expect(isNorth()).toBe(true);
    for (let c = 0; c < FLOOR_CELLS; c++) {
      for (let r = 0; r < FLOOR_CELLS; r++) {
        expect(cellAt(cellCenter(c, r))).toBe(cellOf(c, r));
        expect(centerOf(cellOf(c, r))).toEqual({ x: 960 - (south[c * FLOOR_CELLS + r]?.x ?? NaN), y: 760 - (south[c * FLOOR_CELLS + r]?.y ?? NaN) });
      }
    }
    expect(cellCenter(0, 0)).toEqual({ x: 480, y: 524 });
    expect(cellCenter(9, 9)).toEqual({ x: 480, y: 236 });
    setNorth(false);
    expect(cellCenter(0, 0)).toEqual({ x: 480, y: 236 });
  });

  test("arrow keys keep their screen meaning: Right is down-right on screen from either side", () => {
    expect(stepCell({ x: 4, y: 4 }, "ArrowRight")).toEqual({ x: 5, y: 4 });
    setNorth(true);
    expect(stepCell({ x: 4, y: 4 }, "ArrowRight")).toEqual({ x: 3, y: 4 });
    expect(stepCell({ x: 4, y: 4 }, "ArrowUp")).toEqual({ x: 4, y: 5 });
  });

  test("walks.reflect carries a resting avatar to the other side, and the path it was on", () => {
    const walks = createWalks({ reducedMotion: () => false, smooth: () => true });
    const pose = emptyPose();
    const grid = new Uint8Array(FLOOR_CELLS * FLOOR_CELLS);
    walks.setGrid(grid);
    const p = cellCenter(3, 2);
    walks.place([{ id: "a", at: p, z: 1, seatFacing: null }], 0);
    walks.reflect();
    walks.sample("a", 10, pose);
    expect({ x: pose.x, y: pose.y }).toEqual({ x: 960 - p.x, y: 760 - p.y });
  });
});

describe("viewVerdict", () => {
  const bedroom = cellOf(3, 2);
  const spa = cellOf(3, 7);
  const doorway = cellOf(1, 4);
  test("bedroom side: north when the back sheet is in", () => {
    expect(viewVerdict(dungeon, bedroom, false, false, true)).toEqual({ behind: true, north: true, cut: false });
    expect(viewVerdict(dungeon, spa, true, false, true)).toEqual({ behind: false, north: false, cut: false });
  });
  test("the doorway line keeps the last verdict; no avatar keeps it too", () => {
    expect(viewVerdict(dungeon, doorway, true, false, true).north).toBe(true);
    expect(viewVerdict(dungeon, doorway, false, false, true).north).toBe(false);
    expect(viewVerdict(dungeon, null, true, false, true).north).toBe(true);
  });
  test("editing forces south, with no stubs", () => {
    expect(viewVerdict(dungeon, bedroom, true, true, true)).toEqual({ behind: true, north: false, cut: false });
  });
  test("without the back sheet it stays south and cuts the partitions down (phase A)", () => {
    expect(viewVerdict(dungeon, bedroom, false, false, false)).toEqual({ behind: true, north: false, cut: true });
  });
  test("a room without a partition never turns", () => {
    expect(viewVerdict({ furniture: [] }, bedroom, true, false, true)).toEqual({ behind: false, north: false, cut: false });
  });
  test("usesBack: only a layout with a partition preloads the back sheet", () => {
    expect(usesBack(dungeon)).toBe(true);
    expect(usesBack({ furniture: [] })).toBe(false);
  });
});

describe("sceneOf in the north view (dank-dungeon)", () => {
  const north = (): Scene => {
    setNorth(true);
    return sceneOf(dungeon, sheets, room, back);
  };

  test("one-sided pieces draw their turned frame from furniture-back at the far corner's flipped cell", () => {
    const s = north();
    expect(at(s, "furniture/desk/wood/ne/back")).toEqual([{ x: 256, y: 412, layer: "object" }]);
    expect(at(s, "furniture/minibar/wood/ne/back")).toEqual([{ x: 192, y: 380, layer: "object" }]);
    expect(at(s, "furniture/washbasin/cream/nw/back")).toEqual([{ x: 704, y: 412, layer: "object" }]);
    for (const k of ["furniture/desk/wood/ne/back", "furniture/washbasin/cream/nw/back"]) expect(back.frames[k]).toBeDefined();
    // The source facing's own frames are not drawn.
    expect(at(s, "furniture/desk/wood/sw/back")).toEqual([]);
  });

  test("a piece with no back view draws its source facing's own frame, and partitions are not cut", () => {
    const s = north();
    expect(at(s, "furniture/partition/solid/sw/back")[0]).toEqual({ x: 608, y: 460, layer: "object" });
    expect(at(s, "furniture/coffeetable/wood/sw/back")).toHaveLength(1);
    expect(at(s, "furniture/monstera/teal/sw/back")).toEqual([{ x: 480, y: 236, layer: "object" }]);
    expect(s.sprites.filter((x) => x.use?.frames.some((k) => k.includes("/cut/")))).toEqual([]);
  });

  test("a piece with all four facings draws the turned one, from its own sheet, at its 2×2 far corner", () => {
    const s = north();
    // The beds at (3, 0) and (5, 0) facing nw: far corners (4, 1) and (6, 1) → cells (5, 8) and (3, 8).
    expect(at(s, "furniture/bed/velvet/se/back")).toEqual([{ x: 384, y: 444, layer: "object" }, { x: 320, y: 412, layer: "object" }]);
    expect(at(s, "furniture/bed/velvet/nw/back")).toEqual([]);
  });

  test("wall pieces are gone with the walls they hang on", () => {
    const keys = north().sprites.map((x) => x.key);
    expect(keys.filter((k) => k.includes("neonsign") || k.includes("mirror"))).toEqual([]);
  });

  test("the tv shows its back as an object, and the flat tv hangs at the screen's back corner, once", () => {
    const s = north();
    expect(at(s, "furniture/tv/charcoal/nw/back")).toEqual([{ x: 480, y: 524, layer: "object" }]);
    expect(at(s, "furniture/tv/flat/se/back")).toEqual([{ x: 480, y: 236, layer: "wall" }]);
    expect(at(s, "tv/0")).toEqual([]);
  });

  test("the shell takes the north skin on the raw projection", () => {
    const s = north();
    const keys = s.sprites.map((x) => x.key);
    const floors = (prefix: string): number => keys.filter((k) => k.startsWith(prefix)).length;
    expect(floors("floor/deck/")).toBe(50);
    expect(floors("floor/split/north/")).toBe(10);
    expect(floors("floor/carpet/")).toBe(40);
    expect(at(s, "wall/l/split/north")).toEqual([{ x: 320, y: 316, layer: "wall" }]);
    expect(keys.filter((k) => k === "wall/l/smoke")).toHaveLength(5);
    expect(keys.filter((k) => k === "wall/l/oak")).toHaveLength(4);
    expect(keys.filter((k) => k === "wall/r/smoke")).toHaveLength(FLOOR_CELLS);
    for (const k of ["wall/corner/smoke", "wall/l/end/oak", "wall/r/end/smoke"]) expect(keys).toContain(k);
    expect(keys).not.toContain("wall/r/oak");
  });

  test("seats follow the flip: a wingback's sitter is on the flipped cell", () => {
    const s = north();
    expect(s.seats.map((x) => x.at)).toContainEqual({ x: 288, y: 364 });
  });
});
