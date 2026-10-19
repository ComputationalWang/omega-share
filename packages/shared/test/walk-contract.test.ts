import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  DEFAULT_LAYOUT,
  DOOR_CELL,
  ERROR_CODES,
  FLOOR_CELLS,
  MemberSchema,
  ServerMessageSchema,
  TINT_COUNT,
  WALK_BURST,
  WALK_REFILL_MS,
  isStandable,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

// Free walking and shirt tint (OME-1346, ADR 0053).

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("constants", () => {
  test("walk is 4/s with a burst of 8; six tints; the door is the front corner", () => {
    expect([WALK_BURST, WALK_REFILL_MS, TINT_COUNT]).toEqual([8, 250, 6]);
    expect(DOOR_CELL).toEqual({ x: FLOOR_CELLS - 1, y: FLOOR_CELLS - 1 });
  });
});

describe("client walk", () => {
  test.each([
    [0, 0],
    [9, 9],
    [3, 8],
  ])("accepts (%i, %i)", (x, y) => {
    expect(parseClientMessage(JSON.stringify({ type: "walk", cell: { x, y } }))).toEqual({ type: "walk", cell: { x, y } });
  });

  test.each([
    ["x off the grid", { type: "walk", cell: { x: FLOOR_CELLS, y: 0 } }],
    ["y off the grid", { type: "walk", cell: { x: 0, y: FLOOR_CELLS } }],
    ["negative", { type: "walk", cell: { x: -1, y: 0 } }],
    ["fraction", { type: "walk", cell: { x: 1.5, y: 0 } }],
    ["string", { type: "walk", cell: { x: "1", y: 0 } }],
    ["missing y", { type: "walk", cell: { x: 1 } }],
    ["null cell", { type: "walk", cell: null }],
    ["missing cell", { type: "walk" }],
    ["extra key in cell", { type: "walk", cell: { x: 1, y: 1, z: 0 } }],
    ["extra key", { type: "walk", cell: { x: 1, y: 1 }, memberId: "m1" }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("client walk run (OME-1461)", () => {
  test("run is an optional boolean; absent stays absent", () => {
    for (const run of [true, false]) expect(parseClientMessage(JSON.stringify({ type: "walk", cell: { x: 1, y: 1 }, run }))).toEqual({ type: "walk", cell: { x: 1, y: 1 }, run });
    expect(parseClientMessage(JSON.stringify({ type: "walk", cell: { x: 1, y: 1 } }))).toEqual({ type: "walk", cell: { x: 1, y: 1 } });
  });

  test.each([[1], ["true"], [null], [{}]])("rejects run %p", (run) => {
    rejects(ClientMessageSchema, { type: "walk", cell: { x: 1, y: 1 }, run });
  });

  test("walked carries run when set, rejects a non-boolean one", () => {
    expect(parseServerMessage(JSON.stringify({ type: "walked", memberId: "m1", cell: { x: 2, y: 3 }, run: true }))).toEqual({ type: "walked", memberId: "m1", cell: { x: 2, y: 3 }, run: true });
    expect(parseServerMessage(JSON.stringify({ type: "walked", memberId: "m1", cell: null, run: "yes" }))).toBeNull();
  });
});

describe("client set-tint", () => {
  test("accepts every tint", () => {
    for (let tint = 0; tint < TINT_COUNT; tint++) expect(parseClientMessage(JSON.stringify({ type: "set-tint", tint }))).toEqual({ type: "set-tint", tint });
  });

  test.each([[TINT_COUNT], [-1], [0.5], ["1"], [null]])("rejects %p", (tint) => {
    rejects(ClientMessageSchema, { type: "set-tint", tint });
  });

  test("join takes an optional tint", () => {
    const join = { type: "join" as const, nickname: "alice", avatar: 0 };
    expect(parseClientMessage(JSON.stringify({ ...join, tint: 5 }))).toEqual({ ...join, tint: 5 });
    expect(parseClientMessage(JSON.stringify(join))).toEqual(join);
    rejects(ClientMessageSchema, { ...join, tint: 6 });
    rejects(ClientMessageSchema, { ...join, tint: null });
  });
});

describe("server walked and tint-changed", () => {
  test("walked carries a cell, or null (back to the standing spot)", () => {
    expect(parseServerMessage(JSON.stringify({ type: "walked", memberId: "m1", cell: { x: 2, y: 3 } }))).toEqual({ type: "walked", memberId: "m1", cell: { x: 2, y: 3 } });
    expect(parseServerMessage(JSON.stringify({ type: "walked", memberId: "m1", cell: null }))).toEqual({ type: "walked", memberId: "m1", cell: null });
    expect(parseServerMessage(JSON.stringify({ type: "walked", memberId: "m1", cell: { x: 10, y: 0 } }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ type: "walked", memberId: "m1" }))).toBeNull();
  });

  test("walked strips unknown keys, in the cell too", () => {
    expect(v.parse(ServerMessageSchema, { type: "walked", memberId: "m1", cell: { x: 1, y: 1, z: 2 }, at: 1 })).toEqual({ type: "walked", memberId: "m1", cell: { x: 1, y: 1 } });
  });

  test("tint-changed", () => {
    expect(parseServerMessage(JSON.stringify({ type: "tint-changed", memberId: "m1", tint: 3 }))).toEqual({ type: "tint-changed", memberId: "m1", tint: 3 });
    expect(parseServerMessage(JSON.stringify({ type: "tint-changed", memberId: "m1", tint: 6 }))).toBeNull();
  });

  test("bad_cell is an error code", () => {
    expect(ERROR_CODES).toContain("bad_cell");
  });
});

describe("member", () => {
  const base = { id: "m1", nickname: "alice", avatar: 0 };
  test("cell and tint are optional (absent: standing spot or seated, tint 0)", () => {
    expect(v.parse(MemberSchema, base)).toEqual(base);
    expect(v.parse(MemberSchema, { ...base, cell: { x: 4, y: 9 }, tint: 2 })).toEqual({ ...base, cell: { x: 4, y: 9 }, tint: 2 });
    rejects(MemberSchema, { ...base, cell: { x: 4, y: 10 } });
    rejects(MemberSchema, { ...base, tint: 6 });
  });
});

describe("isStandable", () => {
  test("free floor and rugs yes; solid pieces and seats no", () => {
    expect(isStandable(DEFAULT_LAYOUT, { x: 3, y: 3 })).toBe(true); // on the rug
    expect(isStandable(DEFAULT_LAYOUT, DOOR_CELL)).toBe(true);
    expect(isStandable(DEFAULT_LAYOUT, { x: 0, y: 0 })).toBe(false); // the tv
    expect(isStandable(DEFAULT_LAYOUT, { x: 1, y: 5 })).toBe(false); // an armchair, i.e. a seat
  });
});
