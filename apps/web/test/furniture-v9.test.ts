import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { DEFAULT_LAYOUT, RoomLayoutSchema, type Furniture, type RoomLayout } from "@omega/shared";
import { FurnitureManifestSchema, RoomManifestSchema, V9_COLOURS, sceneOf, standDepth, usesSetG, usesV6, usesV7, usesV9, usesV9Shell, type FurnitureSprite, type Scene } from "../src/furniture";
import { TURN, cellCenter, rawCenter, setNorth } from "../src/layout";

// Rooms wave 26 on the web (OME-2442, art OME-2440): the v9 sheet and its shell, partition loops in the ambient set, the
// walkable tunnel drawn in two layers around a walker, and Stage Door's turned pieces from the north.

const load = async (path: string): Promise<unknown> => Bun.file(new URL(`../../../assets/${path}`, import.meta.url)).json();
const raw9 = v.parse(v.object({ meta: v.object({ omega: v.object({ pieces: v.array(v.object({ id: v.string(), colours: v.array(v.string()) })) }) }) }), await load("furniture/furniture-v9.json"));
const v7 = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v7.json"));
const v9 = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v9.json"));
const v9shell = v.parse(FurnitureManifestSchema, await load("furniture/furniture-v9-shell.json"));
const back = v.parse(FurnitureManifestSchema, await load("furniture/furniture-back.json"));
const room = v.parse(RoomManifestSchema, await load("room/room.json"));

const VELVET = 4;
const WINGS = 5;
const TANK = 6;
const TUNNEL = 7;
const part = (col: number, row: number, facing: "se" | "sw", variant: number): Furniture => ({ kind: "partition", col, row, facing, variant });
/** Reef's partition row: smoked panels at the ends, tanks, the tunnel (the doorway) at (3, 4). */
const REEF: RoomLayout = {
  shell: "reef",
  furniture: [{ kind: "wallscreen", col: 0, row: 7, facing: "se" }, ...Array.from({ length: 10 }, (_, col) => part(col, 4, "sw", col === 3 ? TUNNEL : col === 0 || col === 9 ? 2 : TANK))],
};
/** Stage Door's partition column (col 4): velvet at the ends, wings between, the stage door a gap at (4, 7); the stage riser. */
const STAGE_DOOR: RoomLayout = {
  shell: "stage-door",
  furniture: [
    { kind: "projector", col: 6, row: 0, facing: "sw" },
    { kind: "stage", col: 6, row: 0, facing: "sw" },
    { kind: "vanity", col: 0, row: 8, facing: "se" },
    { kind: "rack", col: 1, row: 6, facing: "sw" },
    ...[0, 1, 2, 3, 4, 5, 6, 8, 9].map((row) => part(4, row, "se", row <= 1 || row >= 8 ? VELVET : WINGS)),
  ],
};
const keysOf = (s: Scene): string[] => s.sprites.map((x) => x.key);
const sprite = (s: Scene, key: string): FurnitureSprite => {
  const found = s.sprites.find((x) => x.key === key);
  if (found === undefined) throw new Error(`no sprite ${key} in ${keysOf(s).join(", ")}`);
  return found;
};
const north = <T>(fn: () => T): T => {
  setNorth(true);
  try {
    return fn();
  } finally {
    setNorth(false);
  }
};

describe("V9_COLOURS is pinned to furniture-v9.json", () => {
  test("the v9 partition colours are variants 4 to 7, in the sheet's order (contract OME-2439)", () => {
    const colours = raw9.meta.omega.pieces.find((p) => p.id === "partition")?.colours ?? [];
    expect(V9_COLOURS).toEqual(Object.fromEntries(colours.map((c, n) => [`partition/${c}`, VELVET + n])));
    expect(V9_COLOURS["partition/tunnel"]).toBe(TUNNEL);
  });
});

describe("usesV9, usesV9Shell", () => {
  test("the wave 26 kinds and the v9 partition colours load v9, and nothing older they don't need", () => {
    expect(usesV9(DEFAULT_LAYOUT)).toBe(false);
    for (const kind of ["stage", "vanity", "rack"] as const) {
      const l: RoomLayout = { furniture: [{ kind, col: 1, row: 1, facing: "se" }] };
      expect(usesV9(l)).toBe(true);
      expect(usesSetG(l)).toBe(false);
    }
    expect(usesV9({ furniture: [part(1, 4, "sw", TANK)] })).toBe(true);
    expect(usesV9({ furniture: [part(1, 4, "sw", 2)] })).toBe(false);
    expect(usesV9({ furniture: [part(1, 4, "sw", 0)] })).toBe(false);
    // Stage Door's partitions are all v9: neither v6's nor v7's partition row loads for them.
    expect(usesV6(STAGE_DOOR)).toBe(false);
    expect(usesV7(STAGE_DOOR)).toBe(false);
    expect(usesV6({ furniture: [part(1, 4, "sw", 1)] })).toBe(true);
    expect(usesV7(REEF)).toBe(true);
  });

  test("the stage-door and reef shells load the v9 shell sheet", () => {
    expect(usesV9Shell(STAGE_DOOR)).toBe(true);
    expect(usesV9Shell(REEF)).toBe(true);
    expect(usesV9Shell({ ...DEFAULT_LAYOUT, shell: "penthouse" })).toBe(false);
    expect(usesV9Shell(DEFAULT_LAYOUT)).toBe(false);
  });
});

describe("sceneOf: partition loops in the ambient set", () => {
  test("Reef's tanks and tunnel loop at rest on the v9 row: 4 × 300 ms, ambient; the smoked panels don't loop", () => {
    const s = sceneOf(REEF, [v7, v9]);
    for (const colour of ["tank", "tunnel"]) {
      expect(sprite(s, `furniture/partition/${colour}/sw/back`).use).toMatchObject({ frames: [0, 1, 2, 3].map((n) => `furniture/partition/${colour}/use/sw/${String(n)}`), ms: 300, ambient: true });
    }
    expect(s.sprites.filter((x) => x.use?.ambient === true)).toHaveLength(8);
    expect(sprite(s, "furniture/partition/panel/sw/back").use?.ambient).toBeUndefined();
  });

  test("Stage Door's stage riser loops at rest (the v9 row's ambient flag)", () => {
    const s = sceneOf(STAGE_DOOR, [v9]);
    expect(sprite(s, "furniture/stage/boards/sw/back").use).toMatchObject({ ms: 300, ambient: true });
    expect(sprite(s, "furniture/rack/costumes/sw/back").use).toBeUndefined();
  });

  test("Stage Door's velvet and wings don't loop at rest (their use frames are one still frame)", () => {
    const s = sceneOf(STAGE_DOOR, [v9]);
    expect(s.sprites.filter((x) => x.key.startsWith("furniture/partition/") && x.use?.ambient === true)).toHaveLength(0);
  });

  // OME-2537: Bar's "Last orders" loops its two neons and the lilac lava lamp; the jukebox (v8) still doesn't.
  test("the bar preset's ambient set is the two neon signs and the lava lamp (v8's flags don't switch on, QA OME-2457)", async () => {
    const sheets = ["furniture", "furniture-v2", "furniture-v4", "furniture-v5", "furniture-v6", "furniture-v7", "furniture-v8", "furniture-v9"];
    const all = await Promise.all(sheets.map(async (name) => v.parse(FurnitureManifestSchema, await load(`furniture/${name}.json`))));
    const bar = v.parse(RoomLayoutSchema, await load("presets/bar.json"));
    const kinds = sceneOf(bar, all).sprites.filter((x) => x.use?.ambient === true).map((x) => x.key.split("/")[1]);
    expect(kinds.sort()).toEqual(["lavalamp", "neonsign", "neonsign"]);
  });
});

describe("sceneOf: the tunnel's two layers", () => {
  const tunnel = (s: Scene): { back: number; front: number } => ({ back: sprite(s, "furniture/partition/tunnel/sw/back").z, front: sprite(s, "furniture/partition/tunnel/sw/front").z });
  /** A walker's depth at a fraction `t` of the way from cell a to cell b. */
  const walker = (a: readonly [number, number], b: readonly [number, number], t: number): number => {
    const p = cellCenter(a[0], a[1]);
    const q = cellCenter(b[0], b[1]);
    return standDepth({ x: Math.round(p.x + (q.x - p.x) * t), y: Math.round(p.y + (q.y - p.y) * t) });
  };

  for (const view of ["south", "north"] as const) {
    test(`from the ${view}, a walker in the tunnel's cell is drawn over its back and under its front; on either side, outside both`, () => {
      const s = view === "north" ? north(() => sceneOf(REEF, [v7, v9])) : sceneOf(REEF, [v7, v9]);
      const z = view === "north" ? north(() => tunnel(s)) : tunnel(s);
      const depth = (a: readonly [number, number], b: readonly [number, number], t: number): number => (view === "north" ? north(() => walker(a, b, t)) : walker(a, b, t));
      expect(z.back).toBeLessThan(z.front);
      // Through the tunnel: (3, 3) in the deep, (3, 4) the tunnel, (3, 5) in the bar.
      for (const t of [0.3, 0.5, 0.7]) {
        expect(depth([3, 3], [3, 5], t)).toBeGreaterThan(z.back);
        expect(depth([3, 3], [3, 5], t)).toBeLessThan(z.front);
      }
      const [far, near] = view === "south" ? [[3, 3] as const, [3, 5] as const] : [[3, 5] as const, [3, 3] as const];
      expect(depth(far, far, 0)).toBeLessThan(z.back);
      expect(depth(near, near, 0)).toBeGreaterThan(z.front);
    });
  }
});

describe("sceneOf: Stage Door from the north", () => {
  test("the stage riser and the dressing table show their turned views from the v9 sheet", () => {
    const keys = north(() => keysOf(sceneOf(STAGE_DOOR, [v9], null, back)));
    expect(keys).toContain(`furniture/stage/boards/${TURN.sw}/back`);
    expect(keys).toContain(`furniture/vanity/bulbs/${TURN.se}/back`);
    // The rail has no turned view: its own frames, as any one-sided piece without one.
    expect(keys).toContain("furniture/rack/costumes/sw/back");
  });

  test("the v9 shell skins Stage Door on its col line, both views", () => {
    const at = (s: Scene, x: number, y: number, prefix: string): string | undefined => {
      const p = rawCenter(x, y);
      return s.sprites.find((k) => k.x === p.x && k.y === p.y && k.key.startsWith(prefix) && !k.key.includes("/end/"))?.key;
    };
    const s = sceneOf(STAGE_DOOR, [v9, v9shell], room);
    expect(at(s, 2, 8, "floor/")).toBe("floor/stage-door/back/0");
    expect(at(s, 4, 8, "floor/")).toBe("floor/stage-door/split/0");
    expect(at(s, 6, 8, "floor/")).toBe("floor/stage-door/front/0");
    expect(at(s, 4, 0, "wall/r/")).toBe("wall/r/stage-door/split");
    const n = north(() => sceneOf(STAGE_DOOR, [v9, v9shell], room));
    expect(at(n, 5, 8, "floor/")).toBe("floor/stage-door/split/north/1");
    expect(at(n, 5, 0, "wall/r/")).toBe("wall/r/stage-door/split/north");
  });
});
