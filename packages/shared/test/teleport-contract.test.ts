import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  DEFAULT_LAYOUT,
  FURNITURE,
  RoomLayoutInputSchema,
  RoomLayoutSchema,
  ServerMessageSchema,
  canTeleport,
  isStandable,
  parseClientMessage,
  parseServerMessage,
  type Furniture,
} from "../src/index";

// Teleport pads (OME-1545, ADR 0053 amendment).

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}
const pad = (col: number, row: number, variant?: number): Furniture => ({ kind: "pad", col, row, facing: "se", ...(variant === undefined ? {} : { variant }) });
const withPads = (...pads: Furniture[]) => ({ furniture: [...DEFAULT_LAYOUT.furniture, ...pads] });

describe("pad kind", () => {
  test("a 1×1 floor piece with one facing and 2 variants", () => {
    expect(FURNITURE.pad).toEqual({ layer: "floor", facings: ["se"], cols: 1, rows: 1, seats: false, variants: 2, wallBacked: false });
  });

  test("a layout holds 0 or exactly 2 pads", () => {
    for (const layout of [DEFAULT_LAYOUT, withPads(pad(9, 1), pad(1, 9, 1))]) {
      expect(v.parse(RoomLayoutInputSchema, layout)).toEqual(layout);
      expect(v.parse(RoomLayoutSchema, layout)).toEqual(layout);
    }
    for (const layout of [withPads(pad(9, 1)), withPads(pad(9, 1), pad(1, 9), pad(8, 9))]) {
      rejects(RoomLayoutInputSchema, layout);
      rejects(RoomLayoutSchema, layout);
    }
  });

  test("a pad takes no other facing, no third variant, and no cell another floor piece has", () => {
    rejects(RoomLayoutInputSchema, withPads({ ...pad(9, 1), facing: "sw" }, pad(1, 9)));
    rejects(RoomLayoutInputSchema, withPads(pad(9, 1, 2), pad(1, 9)));
    rejects(RoomLayoutInputSchema, withPads(pad(9, 1), pad(9, 1)));
    rejects(RoomLayoutInputSchema, withPads(pad(9, 1), pad(2, 2))); // on the rug
  });

  test("a pad is walkable", () => {
    expect(isStandable(withPads(pad(9, 1), pad(1, 9)), { x: 9, y: 1 })).toBe(true);
  });
});

describe("teleport", () => {
  const layout = withPads(pad(9, 1), pad(1, 9));

  test("from one pad to the other, either way; nothing else", () => {
    expect(canTeleport(layout, { x: 9, y: 1 }, { x: 1, y: 9 })).toBe(true);
    expect(canTeleport(layout, { x: 1, y: 9 }, { x: 9, y: 1 })).toBe(true);
    expect(canTeleport(layout, { x: 9, y: 1 }, { x: 9, y: 1 })).toBe(false);
    expect(canTeleport(layout, { x: 8, y: 1 }, { x: 1, y: 9 })).toBe(false);
    expect(canTeleport(layout, { x: 9, y: 1 }, { x: 2, y: 9 })).toBe(false);
    expect(canTeleport(layout, undefined, { x: 1, y: 9 })).toBe(false);
    expect(canTeleport(DEFAULT_LAYOUT, { x: 9, y: 1 }, { x: 1, y: 9 })).toBe(false);
  });

  test("not onto a pad a solid piece covers", () => {
    const covered = withPads(pad(9, 1), pad(0, 9)); // the plant stands on (0, 9)
    expect(v.safeParse(RoomLayoutInputSchema, covered).success).toBe(true);
    expect(canTeleport(covered, { x: 9, y: 1 }, { x: 0, y: 9 })).toBe(false);
  });

  test("walk takes an optional boolean teleport", () => {
    for (const teleport of [true, false]) {
      const msg = { type: "walk", cell: { x: 1, y: 9 }, teleport };
      expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
    }
    for (const teleport of [1, "true", null]) rejects(ClientMessageSchema, { type: "walk", cell: { x: 1, y: 9 }, teleport });
  });

  test("walked relays it", () => {
    const msg = { type: "walked", memberId: "m1", cell: { x: 1, y: 9 }, teleport: true };
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
    rejects(ServerMessageSchema, { ...msg, teleport: "yes" });
  });
});
