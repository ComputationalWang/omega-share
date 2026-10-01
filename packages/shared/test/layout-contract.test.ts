import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  DEFAULT_LAYOUT,
  FLOOR_CELLS,
  FURNITURE,
  FURNITURE_KINDS,
  FurnitureSchema,
  MAX_FURNITURE,
  MAX_SERVER_MESSAGE_BYTES,
  RoomLayoutSchema,
  RoomStateSchema,
  SEAT_COUNT,
  WALL_FIXTURE_SEGMENTS,
  footprintCells,
  layoutSeats,
  parseServerMessage,
  type Furniture,
  type RoomLayout,
  type RoomState,
} from "../src/index";

// Room layout v1 (OME-271, ADR 0021, docs/research/m4-hosting-and-sqlite.md §3).

function accepts(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).issues).toBeUndefined();
}
function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

/** Today's seats (apps/web/src/layout.ts before M4): two rows of four facing the TV. */
const TODAY_SEAT_CELLS = [
  [1, 5], [2, 4], [4, 2], [5, 1],
  [3, 7], [4, 6], [6, 4], [7, 3],
];

const TV: Furniture = { kind: "tv", col: 0, row: 0, facing: "se" };
const chair = (col: number, row: number): Furniture => ({ kind: "armchair", col, row, facing: col < row ? "ne" : "nw" });
const EIGHT_CHAIRS: Furniture[] = TODAY_SEAT_CELLS.map(([c, r]) => chair(c ?? 0, r ?? 0));
const layout = (...furniture: Furniture[]): RoomLayout => ({ furniture });
/** A valid base: the TV and eight armchairs. */
const base = (...more: Furniture[]): RoomLayout => layout(TV, ...EIGHT_CHAIRS, ...more);

/** Every set (g) piece, 8 seats across sofas, a couch, a wingback and a beanbag. */
const CATALOGUE_ROOM: RoomLayout = layout(
  TV,
  { kind: "sofa", col: 1, row: 5, facing: "ne", variant: 1 },
  { kind: "sofa", col: 4, row: 5, facing: "ne" },
  { kind: "couch", col: 6, row: 1, facing: "nw" },
  { kind: "wingback", col: 8, row: 8, facing: "sw" },
  { kind: "beanbag", col: 7, row: 7, facing: "se", variant: 1 },
  { kind: "runner", col: 1, row: 7, facing: "ne", variant: 1 },
  { kind: "bookshelf", col: 3, row: 0, facing: "sw" },
  { kind: "frame", col: 2, row: 0, facing: "sw" },
  { kind: "frame", col: 0, row: 3, facing: "se", variant: 1 },
  { kind: "sidetable", col: 3, row: 5, facing: "se" },
  { kind: "arclamp", col: 9, row: 0, facing: "sw" },
  { kind: "monstera", col: 0, row: 9, facing: "se", variant: 1 },
  { kind: "popcorn", col: 9, row: 9, facing: "sw" },
);

describe("constants", () => {
  test("the floor is 10×10 and a layout holds at most 32 pieces", () => {
    expect(FLOOR_CELLS).toBe(10);
    expect(MAX_FURNITURE).toBe(32);
  });
});

describe("DEFAULT_LAYOUT", () => {
  test("parses", () => {
    accepts(RoomLayoutSchema, DEFAULT_LAYOUT);
  });

  test("its seats are today's SEAT_CELLS, in order, facing the TV", () => {
    expect(layoutSeats(DEFAULT_LAYOUT).map((s) => [s.col, s.row])).toEqual(TODAY_SEAT_CELLS);
    expect(layoutSeats(DEFAULT_LAYOUT).map((s) => s.facing)).toEqual(["ne", "ne", "nw", "nw", "ne", "ne", "nw", "nw"]);
  });

  test("is today's room: the corner TV, the 7×7 rug, the lamp and the plant", () => {
    const others = DEFAULT_LAYOUT.furniture.filter((f) => f.kind !== "armchair");
    expect(others).toEqual([
      { kind: "tv", col: 0, row: 0, facing: "se" },
      { kind: "rug", col: 1, row: 1, facing: "se" },
      { kind: "lamp", col: 9, row: 0, facing: "se" },
      { kind: "plant", col: 0, row: 9, facing: "se" },
    ]);
  });

  test("round-trips through JSON in a snapshot", () => {
    const room: RoomState = { id: "lobby", seats: Array<null>(SEAT_COUNT).fill(null), members: [], embed: null, playback: null, layout: DEFAULT_LAYOUT };
    const msg = parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room }));
    expect(msg?.type === "snapshot" ? msg.room.layout : null).toEqual(DEFAULT_LAYOUT);
  });
});

describe("RoomStateSchema.layout", () => {
  const room = { id: "lobby", seats: Array<null>(SEAT_COUNT).fill(null), members: [], embed: null, playback: null };

  test("an old snapshot without a layout still parses, and gains none", () => {
    const out = v.parse(RoomStateSchema, room);
    expect("layout" in out).toBe(false);
  });

  test("a snapshot with a bad layout is rejected", () => {
    rejects(RoomStateSchema, { ...room, layout: layout(TV, TV, ...EIGHT_CHAIRS) });
    rejects(RoomStateSchema, { ...room, layout: null });
  });
});

describe("accepted layouts", () => {
  test("every set (g) piece, with multi-seat sofas", () => {
    accepts(RoomLayoutSchema, CATALOGUE_ROOM);
  });

  test("seat i is the i-th seat cell across seat pieces, in furniture order", () => {
    expect(layoutSeats(CATALOGUE_ROOM)).toEqual([
      { col: 1, row: 5, facing: "ne" },
      { col: 2, row: 5, facing: "ne" },
      { col: 4, row: 5, facing: "ne" },
      { col: 5, row: 5, facing: "ne" },
      { col: 6, row: 1, facing: "nw" },
      { col: 6, row: 2, facing: "nw" },
      { col: 8, row: 8, facing: "sw" },
      { col: 7, row: 7, facing: "se" },
    ]);
  });

  test("a runner and a rug may sit under seats", () => {
    accepts(RoomLayoutSchema, base({ kind: "runner", col: 3, row: 5, facing: "nw" }));
  });

  test("exactly MAX_FURNITURE pieces", () => {
    const used = new Set(["0,0", ...TODAY_SEAT_CELLS.map(([c, r]) => `${String(c)},${String(r)}`)]);
    const fill: Furniture[] = [];
    for (let col = 0; col < FLOOR_CELLS && fill.length < MAX_FURNITURE - 9; col++) {
      for (let row = 0; row < FLOOR_CELLS && fill.length < MAX_FURNITURE - 9; row++) {
        if (!used.has(`${String(col)},${String(row)}`)) fill.push({ kind: "sidetable", col, row, facing: "sw" });
      }
    }
    const full = base(...fill);
    expect(full.furniture).toHaveLength(MAX_FURNITURE);
    accepts(RoomLayoutSchema, full);
  });

  test("a worst-case snapshot with a full layout stays under the server frame cap", () => {
    const members = Array.from({ length: 25 }, (_, i) => ({ id: `m${String(i).padStart(63, "0")}`, nickname: "W".repeat(20), avatar: 3, catching: true }));
    const furniture: Furniture[] = [TV, ...Array.from({ length: 8 }, (_, i) => ({ kind: "wingback" as const, col: i + 1, row: 9, facing: "sw" as const, variant: 0 }))];
    for (let col = 1; col < FLOOR_CELLS && furniture.length < MAX_FURNITURE; col++) {
      for (let row = 1; row < 9 && furniture.length < MAX_FURNITURE; row++) furniture.push({ kind: "sidetable", col, row, facing: "sw", variant: 0 });
    }
    const room = { id: "a".repeat(32), seats: members.slice(0, 8).map((m) => m.id), members, embed: null, playback: null, layout: { furniture } };
    accepts(RoomStateSchema, room);
    const frame = JSON.stringify({ type: "snapshot", self: members[0]?.id, room });
    expect(new TextEncoder().encode(frame).length).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
  });
});

describe("rejected layouts", () => {
  test.each([
    ["no tv", layout(...EIGHT_CHAIRS)],
    ["two tvs", base({ kind: "tv", col: 9, row: 9, facing: "se" })],
    ["seven seats", layout(TV, ...EIGHT_CHAIRS.slice(1))],
    ["nine seats", base(chair(9, 9))],
    ["nine seats via a sofa", layout(TV, ...EIGHT_CHAIRS.slice(1), { kind: "sofa", col: 8, row: 8, facing: "ne" })],
    ["two chairs on one cell", layout(TV, ...EIGHT_CHAIRS.slice(1), chair(2, 4))],
    ["a solid piece on the tv", base({ kind: "plant", col: 0, row: 0, facing: "se" })],
    ["a sofa's second cell on a chair", base({ kind: "sofa", col: 0, row: 5, facing: "ne" })],
    ["two rugs overlapping", base({ kind: "rug", col: 1, row: 1, facing: "se" }, { kind: "runner", col: 2, row: 2, facing: "ne" })],
    ["two frames on one wall segment", base({ kind: "frame", col: 2, row: 0, facing: "sw" }, { kind: "frame", col: 2, row: 0, facing: "sw", variant: 1 })],
    ["furniture not an array", { furniture: {} }],
    ["missing furniture", {}],
  ])("rejects %s", (_name, input) => {
    rejects(RoomLayoutSchema, input);
  });

  test("over MAX_FURNITURE even when every rule else holds", () => {
    const used = new Set(["0,0", ...TODAY_SEAT_CELLS.map(([c, r]) => `${String(c)},${String(r)}`)]);
    const fill: Furniture[] = [];
    for (let col = 0; col < FLOOR_CELLS; col++) {
      for (let row = 0; row < FLOOR_CELLS; row++) {
        if (!used.has(`${String(col)},${String(row)}`)) fill.push({ kind: "sidetable", col, row, facing: "sw" });
      }
    }
    rejects(RoomLayoutSchema, base(...fill.slice(0, MAX_FURNITURE - 8)));
  });
});

describe("FurnitureSchema", () => {
  test.each([
    ["armchair", { kind: "armchair", col: 0, row: 0, facing: "sw" }],
    ["a variant", { kind: "sofa", col: 0, row: 0, facing: "ne", variant: 1 }],
    ["a rug touching the far corner", { kind: "rug", col: 3, row: 3, facing: "se" }],
    ["a runner touching the far edge", { kind: "runner", col: 7, row: 8, facing: "ne" }],
    ["a frame on the left wall", { kind: "frame", col: 0, row: 9, facing: "se" }],
    ["an unknown extra key (server objects are non-strict)", { kind: "tv", col: 0, row: 0, facing: "se", glow: true }],
  ])("accepts %s", (_name, input) => {
    accepts(FurnitureSchema, input);
  });

  test.each([
    ["an unknown kind", { kind: "throne", col: 0, row: 0, facing: "se" }],
    ["a kind that only exists as an atlas id", { kind: "kilim", col: 0, row: 0, facing: "ne" }],
    ["a non-integer col", { kind: "tv", col: 1.5, row: 0, facing: "se" }],
    ["a non-integer row", { kind: "tv", col: 0, row: 0.25, facing: "se" }],
    ["a string cell", { kind: "tv", col: "0", row: 0, facing: "se" }],
    ["a negative cell", { kind: "tv", col: -1, row: 0, facing: "se" }],
    ["a cell past the floor", { kind: "tv", col: 0, row: 10, facing: "se" }],
    ["NaN", { kind: "tv", col: Number.NaN, row: 0, facing: "se" }],
    ["an unknown facing", { kind: "armchair", col: 0, row: 0, facing: "n" }],
    ["a facing the piece does not have", { kind: "sidetable", col: 0, row: 0, facing: "ne" }],
    ["a facing a one-sprite piece does not have", { kind: "lamp", col: 0, row: 0, facing: "sw" }],
    ["a variant the piece does not have", { kind: "wingback", col: 0, row: 0, facing: "ne", variant: 1 }],
    ["a negative variant", { kind: "sofa", col: 0, row: 0, facing: "ne", variant: -1 }],
    ["a non-integer variant", { kind: "sofa", col: 0, row: 0, facing: "ne", variant: 0.5 }],
    ["a rug hanging off the floor", { kind: "rug", col: 4, row: 3, facing: "se" }],
    ["a runner hanging off the floor", { kind: "runner", col: 8, row: 0, facing: "ne" }],
    ["a turned runner hanging off the floor", { kind: "runner", col: 0, row: 8, facing: "nw" }],
    ["a sofa hanging off the floor", { kind: "sofa", col: 9, row: 0, facing: "ne" }],
    ["a turned sofa hanging off the floor", { kind: "sofa", col: 0, row: 9, facing: "se" }],
    ["a bookcase away from its wall", { kind: "bookshelf", col: 3, row: 1, facing: "sw" }],
    ["a left-wall bookcase away from its wall", { kind: "bookshelf", col: 1, row: 3, facing: "se" }],
    ["a frame off the wall", { kind: "frame", col: 2, row: 1, facing: "sw" }],
    ["a frame on a window segment", { kind: "frame", col: 0, row: 5, facing: "se" }],
    ["a frame on a sconce segment", { kind: "frame", col: 8, row: 0, facing: "sw" }],
    ["a missing facing", { kind: "tv", col: 0, row: 0 }],
  ])("rejects %s", (_name, input) => {
    rejects(FurnitureSchema, input);
  });

  test("footprints turn with the facing: ne/sw keep cols × rows, nw/se swap them", () => {
    expect(footprintCells({ kind: "sofa", col: 2, row: 3, facing: "ne" })).toEqual([[2, 3], [3, 3]]);
    expect(footprintCells({ kind: "sofa", col: 2, row: 3, facing: "se" })).toEqual([[2, 3], [2, 4]]);
    expect(footprintCells({ kind: "frame", col: 2, row: 0, facing: "sw" })).toEqual([]);
    expect(footprintCells({ kind: "rug", col: 1, row: 1, facing: "se" })).toHaveLength(49);
  });
});

// The contract restates the art manifests so the server needs no asset files. These pin it to them.
const PieceSchema = v.object({
  id: v.string(),
  layer: v.string(),
  colours: v.array(v.string()),
  dirs: v.array(v.string()),
  footprintByDir: v.record(v.string(), v.object({ cols: v.number(), rows: v.number() })),
  seatsByDir: v.optional(v.record(v.string(), v.array(v.object({ col: v.number(), row: v.number(), dir: v.string() })))),
});
const ASSETS = join(import.meta.dir, "..", "..", "..", "assets");
const readJson = (path: string): unknown => JSON.parse(readFileSync(join(ASSETS, path), "utf8"));

describe("the catalogue matches the art", () => {
  const furnitureMeta = v.parse(v.object({ meta: v.object({ omega: v.object({ pieces: v.array(PieceSchema) }) }) }), readJson("furniture/furniture.json"));
  /** Contract kind → set (g) atlas id. The kilim runner is `rug` in the atlas; the contract's `rug` is the room's. */
  const atlasId = (kind: string): string => (kind === "runner" ? "rug" : kind);

  test("every set (g) piece is a kind", () => {
    const kinds: readonly string[] = FURNITURE_KINDS;
    for (const p of furnitureMeta.meta.omega.pieces) expect(kinds).toContain(p.id === "rug" ? "runner" : p.id);
  });

  test.each(furnitureMeta.meta.omega.pieces.map((p) => [p.id === "rug" ? "runner" : p.id, p] as const))("%s: facings, variants, layer, footprints and seats", (kind, piece) => {
    const spec = FURNITURE[v.parse(v.picklist(FURNITURE_KINDS), kind)];
    expect(atlasId(kind)).toBe(piece.id);
    expect(spec.facings.map(String).sort()).toEqual([...piece.dirs].sort());
    expect(spec.variants).toBe(piece.colours.length);
    expect(spec.layer).toBe(piece.layer === "wall" ? "wall" : piece.layer === "floor" ? "floor" : "object");
    for (const facing of spec.facings) {
      const fp = piece.footprintByDir[facing];
      const cells = footprintCells({ kind: v.parse(v.picklist(FURNITURE_KINDS), kind), col: 0, row: 0, facing });
      expect(cells.length).toBe((fp?.cols ?? 0) * (fp?.rows ?? 0));
      const seats = (piece.seatsByDir?.[facing] ?? []).map((s): (number | string)[] => [s.col, s.row, s.dir]);
      const ours = spec.seats ? cells.map(([c, r]): (number | string)[] => [c, r, facing]) : [];
      expect(ours).toEqual(seats);
    }
  });

  const roomMeta = v.parse(
    v.object({ meta: v.object({ omega: v.object({ seats: v.array(v.object({ frame: v.string(), dirs: v.array(v.string()) })), layout: v.object({ walls: v.object({ l: v.array(v.string()), r: v.array(v.string()) }), floor: v.array(v.array(v.string())) }) }) }) }),
    readJson("room/room.json"),
  );

  test("the room armchair faces every way and seats one", () => {
    expect(FURNITURE.armchair.facings.map(String).sort()).toEqual([...(roomMeta.meta.omega.seats[0]?.dirs ?? [])].sort());
    expect(footprintCells({ kind: "armchair", col: 0, row: 0, facing: "ne" })).toEqual([[0, 0]]);
    expect(FURNITURE.armchair.seats).toBe(true);
  });

  test("the room rug is the 7×7 rug painted into the default floor", () => {
    const rugCells = new Set(footprintCells({ kind: "rug", col: 1, row: 1, facing: "se" }).map(([c, r]) => `${String(c)},${String(r)}`));
    const painted = new Set<string>();
    roomMeta.meta.omega.layout.floor.forEach((rowKeys, r) => {
      rowKeys.forEach((key, c) => {
        if (key.startsWith("rug/")) painted.add(`${String(c)},${String(r)}`);
      });
    });
    expect([...painted].sort()).toEqual([...rugCells].sort());
  });

  test("WALL_FIXTURE_SEGMENTS are the window, poster and sconce segments of both walls", () => {
    const fixtures = (keys: readonly string[]): number[] => keys.flatMap((k, i) => (k.endsWith("/plain") ? [] : [i]));
    expect(fixtures(roomMeta.meta.omega.layout.walls.l)).toEqual([...WALL_FIXTURE_SEGMENTS]);
    expect(fixtures(roomMeta.meta.omega.layout.walls.r)).toEqual([...WALL_FIXTURE_SEGMENTS]);
  });
});
