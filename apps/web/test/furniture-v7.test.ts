import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, RoomLayoutSchema, layoutSeats, type RoomLayout } from "@omega/shared";
import { FurnitureManifestSchema, RoomManifestSchema, V7_COLOURS, sceneKey, sceneOf, seatPoints, seatTiles, usesSetG, usesV6, usesV7, type Scene } from "../src/furniture";
import { cellCenter } from "../src/layout";
import { pieceSeats } from "../src/walk/lie";

// The Dank Dungeon v7 hookup (OME-1991): lazy sheet, variant-to-colour table, shell skin, seats that follow layoutSeats.

const load = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const manifest = v.parse(FurnitureManifestSchema, await load("furniture/furniture.json"));
const v5 = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v5.json"));
const v6 = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v6.json"));
const v7 = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v7.json"));
const room = v.parse(RoomManifestSchema, await load("room/room.json"));
const preset = v.parse(v.object({ shell: v.optional(v.literal("dungeon")), furniture: v.array(v.unknown()) }), await load("presets/dank-dungeon.json"));
const dungeon: RoomLayout = v.parse(RoomLayoutSchema, { furniture: preset.furniture, ...(preset.shell === undefined ? {} : { shell: preset.shell }) });

const keysOf = (s: Scene): string[] => s.sprites.map((x) => x.key);
const one = (...furniture: RoomLayout["furniture"]): RoomLayout => ({ furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }, ...furniture] });

describe("usesV7", () => {
  test("a default layout does not load v7; v7 kinds, v7 variants and the dungeon shell do", () => {
    expect(usesV7(DEFAULT_LAYOUT)).toBe(false);
    expect(usesV7(one({ kind: "sauna", col: 0, row: 8, facing: "se" }))).toBe(true);
    expect(usesV7(one({ kind: "mirror", col: 0, row: 5, facing: "se", variant: 1 }))).toBe(true);
    expect(usesV7(one({ kind: "mirror", col: 0, row: 5, facing: "se" }))).toBe(false);
    expect(usesV7(one({ kind: "partition", col: 1, row: 4, facing: "se", variant: 2 }))).toBe(true);
    expect(usesV7(one({ kind: "partition", col: 1, row: 4, facing: "se", variant: 1 }))).toBe(false);
    expect(usesV7({ ...DEFAULT_LAYOUT, shell: "dungeon" })).toBe(true);
    expect(usesV7(dungeon)).toBe(true);
  });

  test("v7 kinds pull neither set (g) nor v6", () => {
    const l = one({ kind: "sauna", col: 0, row: 8, facing: "se" }, { kind: "soaktub", col: 3, row: 6, facing: "se" }, { kind: "lounger", col: 8, row: 5, facing: "nw" });
    expect(usesSetG({ furniture: l.furniture.filter((f) => f.kind !== "tv") })).toBe(false);
    expect(usesV6(l)).toBe(false);
  });
});

describe("V7_COLOURS is pinned to furniture-v7.json", () => {
  const older = new Set([...manifest.meta.omega.pieces, ...v5.meta.omega.pieces, ...v6.meta.omega.pieces].map((p) => p.id));
  test("every colour v7 adds to an older kind (or the tv) has a variant, and every entry names one", () => {
    const expected = v7.meta.omega.pieces.filter((p) => older.has(p.id) || p.id === "tv").flatMap((p) => p.colours.map((c) => `${p.id}/${c}`));
    expect(expected.length).toBe(6);
    expect(Object.keys(V7_COLOURS).sort()).toEqual(expected.sort());
  });
  test("the variants follow the older sheets' colours", () => {
    expect(V7_COLOURS).toEqual({ "mirror/silver": 1, "minibar/fridge": 1, "carpet/oval": 1, "tv/flat": 1, "partition/panel": 2, "partition/panelglass": 3 });
  });
});

describe("sceneOf: a variant picks its colour across sheets", () => {
  const all = [manifest, v5, v6, v7];
  const draws = (kind: "mirror" | "minibar" | "carpet" | "partition", variant: number, sheets = all, facing: "se" | "sw" = "se"): string[] =>
    keysOf(sceneOf(one({ kind, col: 4, row: 4, facing, variant }), sheets, room)).filter((k) => k.startsWith("furniture/"));
  test("the older sheets keep variant 0 (and partition glass = 1)", () => {
    expect(draws("mirror", 0)).toEqual(["furniture/mirror/brass/se/back"]);
    expect(draws("minibar", 0)).toEqual(["furniture/minibar/wood/se/back"]);
    expect(draws("carpet", 0)).toEqual(["furniture/carpet/navy/se/back"]);
    expect(draws("partition", 1)).toEqual(["furniture/partition/glass/se/back"]);
  });
  test("v7's colours come from v7", () => {
    expect(draws("mirror", 1)).toEqual(["furniture/mirror/silver/se/back"]);
    expect(draws("minibar", 1)).toEqual(["furniture/minibar/fridge/se/back"]);
    expect(draws("carpet", 1)).toEqual(["furniture/carpet/oval/se/back"]);
    expect(draws("partition", 2)).toEqual(["furniture/partition/panel/se/back"]);
    expect(draws("partition", 3, all, "sw")).toEqual(["furniture/partition/panelglass/sw/back"]);
  });
  test("without v7 a v7 variant draws the first colour", () => {
    expect(draws("mirror", 1, [manifest, v6])).toEqual(["furniture/mirror/brass/se/back"]);
  });
  test("every key is a frame of the sheet it came from", () => {
    for (const [kind, variant] of [["mirror", 1], ["minibar", 1], ["carpet", 1], ["partition", 2], ["partition", 3]] as const) {
      for (const k of draws(kind, variant)) expect(v7.frames[k]).toBeDefined();
    }
  });
  test("the flat tv draws v7's frame on the console's anchor, else the room atlas console", () => {
    const flat = sceneOf({ furniture: [{ kind: "tv", col: 0, row: 0, facing: "se", variant: 1 }] }, all, room);
    const base = sceneOf({ furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }] }, all, room);
    const f = flat.sprites.find((s) => s.key === "furniture/tv/flat/se/back");
    const b = base.sprites.find((s) => s.key === "tv/0");
    expect(f).toBeDefined();
    expect(b).toBeDefined();
    expect(f).toMatchObject({ x: b?.x, y: b?.y, layer: b?.layer, z: b?.z });
    expect(keysOf(flat)).not.toContain("tv/0");
    expect(keysOf(sceneOf({ furniture: [{ kind: "tv", col: 0, row: 0, facing: "se", variant: 1 }] }, [manifest, v6], room))).toContain("tv/0");
  });
  test("a seated soaktub has a front sprite above its sitters", () => {
    const s = sceneOf(one({ kind: "soaktub", col: 3, row: 6, facing: "se" }), all, room);
    const front = s.sprites.find((x) => x.key === "furniture/soaktub/cedar/se/front");
    expect(front).toBeDefined();
    expect(s.seats).toHaveLength(2);
    for (const seat of s.seats) expect(front?.z).toBeGreaterThan(seat.z);
  });
});

describe("sceneOf: the dungeon shell skin", () => {
  const withShell = (extra: RoomLayout["furniture"] = []): RoomLayout => ({ ...one(...extra), shell: "dungeon" });
  const shell = (s: Scene): string[] => keysOf(s).filter((k) => /^(floor|wall)\//.test(k));
  test("floors, walls, corner and ends swap keys, all frames of v7", () => {
    const s = sceneOf(withShell(), [v7], room);
    const keys = shell(s);
    expect(keys).toHaveLength(100 + 20 + 3);
    for (const k of keys) expect(v7.frames[k]).toBeDefined();
    const at = (col: number, row: number, layer: "floor" | "wall"): string | undefined => {
      const p = cellCenter(col, row);
      return s.sprites.find((x) => x.layer === layer && x.x === p.x && x.y === p.y && (layer === "floor" ? x.key.startsWith("floor/") : x.key.startsWith("wall/l/") && !x.key.includes("end")))?.key;
    };
    expect(at(0, 0, "floor")).toBe("floor/carpet/0");
    expect(at(3, 2, "floor")).toBe("floor/carpet/1");
    expect(at(5, 4, "floor")).toBe("floor/split/1");
    expect(at(2, 9, "floor")).toBe("floor/deck/1");
    expect(at(0, 0, "wall")).toBe("wall/l/oak");
    expect(at(0, 3, "wall")).toBe("wall/l/oak");
    expect(at(0, 4, "wall")).toBe("wall/l/split");
    expect(at(0, 5, "wall")).toBe("wall/l/smoke");
    expect(keys.filter((k) => k === "wall/r/oak")).toHaveLength(10);
    for (const k of ["wall/corner/oak", "wall/l/end/smoke", "wall/r/end/oak"]) expect(keys).toContain(k);
  });
  test("the rug still draws, and wall pieces hang on the skin", () => {
    const s = sceneOf(withShell([{ kind: "rug", col: 1, row: 1, facing: "se" }, { kind: "mirror", col: 0, row: 5, facing: "se" }]), [v7], room);
    expect(keysOf(s).filter((k) => k.startsWith("rug/"))).toHaveLength(49);
    expect(keysOf(s)).not.toContain("wall/l/plain");
    expect(keysOf(s)).toContain("wall/l/smoke");
  });
  test("without v7 or without the shell, the shell is today's", () => {
    const plain = shell(sceneOf(one(), [], room));
    expect(shell(sceneOf(withShell(), [], room))).toEqual(plain);
    expect(shell(sceneOf(one(), [v7], room))).toEqual(plain);
  });
});

describe("seats follow layoutSeats", () => {
  test("a 2x2 bed, a lounger and a soaktub count the seat cells, not the footprint", () => {
    for (const l of [one({ kind: "bed", col: 2, row: 0, facing: "se" }), one({ kind: "lounger", col: 8, row: 5, facing: "nw" }), one({ kind: "soaktub", col: 3, row: 6, facing: "se" })]) {
      expect(seatPoints(l)).toHaveLength(layoutSeats(l).length);
      expect(seatTiles(l)).toHaveLength(layoutSeats(l).length);
      const [a, b] = pieceSeats(l, 1);
      expect(b - a).toBe(layoutSeats(l).length);
      expect(sceneOf(l, [v6, v7]).seats).toHaveLength(layoutSeats(l).length);
    }
    expect(layoutSeats(one({ kind: "lounger", col: 8, row: 5, facing: "nw" }))).toHaveLength(1);
  });
  test("the dank dungeon preset: seat i is the same cell everywhere", () => {
    const seats = layoutSeats(dungeon);
    const cells = seats.map((s) => cellCenter(s.col, s.row));
    expect(seatPoints(dungeon)).toEqual(cells);
    expect(seatTiles(dungeon)).toEqual(cells);
    expect(sceneOf(dungeon, [manifest, v5, v6, v7], room).seats.map((s) => s.at)).toEqual(cells);
    const total = dungeon.furniture.reduce((n, _f, i) => n + pieceSeats(dungeon, i)[1] - pieceSeats(dungeon, i)[0], 0);
    expect(total).toBe(seats.length);
  });
});

describe("the night pane mask (OME-1994 art)", () => {
  const panes = (l: RoomLayout): Scene["sprites"] => sceneOf(l, [v6, v7]).sprites.filter((s) => s.key.includes("/pane/"));
  const wall = (variant: number, mood?: RoomLayout["mood"]): RoomLayout => ({ ...one({ kind: "partition", col: 1, row: 4, facing: "sw", variant }), ...(mood === undefined ? {} : { mood }) });

  test("glass partitions (variants 1 and 3) get their pane at ~20% alpha over the back frame, at night only", () => {
    for (const [variant, colour] of [[1, "glass"], [3, "panelglass"]] as const) {
      const [pane, ...rest] = panes(wall(variant, "night"));
      expect(rest).toEqual([]);
      const back = sceneOf(wall(variant, "night"), [v6, v7]).sprites.find((s) => s.key === `furniture/partition/${colour}/sw/back`);
      expect(pane).toMatchObject({ key: `furniture/partition/${colour}/pane/sw`, alpha: 0.2, x: back?.x, y: back?.y, z: back?.z, layer: back?.layer });
      expect(panes(wall(variant))).toEqual([]);
      expect(panes(wall(variant, "warm"))).toEqual([]);
    }
  });

  test("solid partitions (variants 0 and 2) have no pane", () => {
    expect(panes(wall(0, "night"))).toEqual([]);
    expect(panes(wall(2, "night"))).toEqual([]);
  });

  test("a night room with a glass partition loads v7 for the pane", () => {
    expect(usesV7(wall(1, "night"))).toBe(true);
    expect(usesV7(wall(1))).toBe(false);
    expect(usesV7(wall(0, "night"))).toBe(false);
  });

  test("the scene key changes with the mood, so the stage redraws", () => {
    expect(sceneKey(wall(1, "night"))).not.toBe(sceneKey(wall(1)));
    expect(sceneKey(wall(1, "none"))).toBe(sceneKey(wall(1)));
  });
});
