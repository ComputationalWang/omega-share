import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  DICE_MAX_SIDES,
  DICE_MIN_SIDES,
  FURNITURE,
  FurnitureSchema,
  MAX_DOORS,
  RoomLayoutInputSchema,
  RoomLayoutSchema,
  ServerMessageSchema,
  hasDoorTo,
  parseClientMessage,
  parseServerMessage,
  type Furniture,
  type RoomLayout,
} from "../src/index";

// Doors between rooms and /roll dice (OME-1423, ADR 0054).

const accepts = (schema: v.GenericSchema, input: unknown): void => expect(v.safeParse(schema, input).issues).toBeUndefined();
const rejects = (schema: v.GenericSchema, input: unknown): void => expect(v.safeParse(schema, input).success).toBe(false);

const SEATS = [[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const;
const base = (...more: unknown[]): unknown => ({
  furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }, ...SEATS.map(([col, row]) => ({ kind: "armchair", col, row, facing: col < row ? "ne" : "nw" })), ...more],
});
const door = (col: number, row: number, more: Record<string, unknown> = {}): Record<string, unknown> => ({
  kind: "door",
  col,
  row,
  facing: row === 0 ? "sw" : "se",
  target: "lobby",
  ...more,
});

describe("the door piece", () => {
  test("is a wall-backed 1×1 object facing the camera, in 2 variants", () => {
    expect(FURNITURE.door).toEqual({ layer: "object", facings: ["se", "sw"], cols: 1, rows: 1, seats: false, variants: 2, wallBacked: true });
  });

  test("carries a target room id; it round-trips after variant", () => {
    const parsed = v.parse(FurnitureSchema, { kind: "door", col: 3, row: 0, facing: "sw", target: "film-club", variant: 1 });
    expect(JSON.stringify(parsed)).toBe('{"kind":"door","col":3,"row":0,"facing":"sw","variant":1,"target":"film-club"}');
  });

  test.each([
    ["no target", door(3, 0, { target: undefined })],
    ["a null target", door(3, 0, { target: null })],
    ["a URL", door(3, 0, { target: "https://evil.example/" })],
    ["a path", door(3, 0, { target: "/rooms/lobby" })],
    ["upper case", door(3, 0, { target: "Lobby" })],
    ["empty", door(3, 0, { target: "" })],
    ["too long", door(3, 0, { target: "a".repeat(33) })],
    ["a number", door(3, 0, { target: 7 })],
    ["off its wall", door(3, 1, { facing: "sw" })],
    ["facing away", door(3, 0, { facing: "ne" })],
    ["a third variant", door(3, 0, { variant: 2 })],
  ])("refuses a door with %s", (_name, d) => {
    rejects(FurnitureSchema, d);
  });

  test("a target on any other piece is refused", () => {
    rejects(FurnitureSchema, { kind: "plant", col: 9, row: 9, facing: "se", target: "lobby" });
    rejects(FurnitureSchema, { kind: "frame", col: 2, row: 0, facing: "sw", target: "lobby" });
  });

  test(`a layout holds at most MAX_DOORS (${String(MAX_DOORS)}) doors, on both parsers`, () => {
    expect(MAX_DOORS).toBe(2);
    for (const schema of [RoomLayoutSchema, RoomLayoutInputSchema]) {
      accepts(schema, base(door(3, 0)));
      accepts(schema, base(door(3, 0), door(0, 3, { target: "other-room" })));
      rejects(schema, base(door(3, 0), door(4, 0), door(0, 3)));
    }
  });

  test("a door is solid and may not share a cell with another solid piece", () => {
    rejects(RoomLayoutSchema, base(door(3, 0), { kind: "plant", col: 3, row: 0, facing: "se" }));
  });

  test("hasDoorTo says whether any door leads to a room (a door may not lead to its own room)", () => {
    const l = v.parse(RoomLayoutSchema, base(door(3, 0, { target: "film-club" }), door(0, 3, { target: "lobby" }))) as RoomLayout;
    expect(hasDoorTo(l, "lobby")).toBe(true);
    expect(hasDoorTo(l, "film-club")).toBe(true);
    expect(hasDoorTo(l, "film")).toBe(false);
    expect(hasDoorTo({ furniture: [] as Furniture[] }, "lobby")).toBe(false);
  });

  test("a layout-set with a door parses", () => {
    expect(parseClientMessage(JSON.stringify({ type: "layout-set", layout: base(door(3, 0)) }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "layout-set", layout: base(door(3, 0, { extra: 1 })) }))).toBeNull();
  });
});

describe("roll", () => {
  test(`sides is an integer ${String(DICE_MIN_SIDES)}..${String(DICE_MAX_SIDES)}`, () => {
    expect([DICE_MIN_SIDES, DICE_MAX_SIDES]).toEqual([2, 100]);
    for (const sides of [2, 6, 20, 100]) expect(parseClientMessage(JSON.stringify({ type: "roll", sides }))).toEqual({ type: "roll", sides });
    for (const sides of [1, 0, -6, 101, 6.5, "6", null, true, 1e9])
      expect(parseClientMessage(JSON.stringify({ type: "roll", sides }))).toBeNull();
    expect(parseClientMessage('{"type":"roll"}')).toBeNull();
    expect(parseClientMessage('{"type":"roll","sides":6,"value":6}')).toBeNull();
  });

  test("rolled carries who, the die and a value in 1..sides", () => {
    const rolled = { type: "rolled", memberId: "m1", sides: 6, value: 4 };
    expect(parseServerMessage(JSON.stringify(rolled))).toEqual(rolled);
    for (const value of [1, 6]) accepts(ServerMessageSchema, { ...rolled, value });
    for (const value of [0, 7, 2.5, -1, "4", null]) rejects(ServerMessageSchema, { ...rolled, value });
    for (const sides of [1, 101, 6.5]) rejects(ServerMessageSchema, { ...rolled, sides, value: 1 });
    rejects(ServerMessageSchema, { ...rolled, memberId: "a b" });
  });
});
