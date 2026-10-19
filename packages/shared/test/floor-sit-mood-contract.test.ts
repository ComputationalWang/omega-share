import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  DEFAULT_LAYOUT,
  MemberSchema,
  ROOM_MOODS,
  RoomLayoutInputSchema,
  RoomLayoutSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

// Floor sit and room mood (OME-1499, ADR 0053 amendment).

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("floor sit", () => {
  test("client floor-sit takes a boolean on", () => {
    for (const on of [true, false]) expect(parseClientMessage(JSON.stringify({ type: "floor-sit", on }))).toEqual({ type: "floor-sit", on });
    for (const on of [1, "true", null, undefined]) rejects(ClientMessageSchema, { type: "floor-sit", on });
    rejects(ClientMessageSchema, { type: "floor-sit", on: true, memberId: "m1" });
  });

  test("server floor-sat names the member", () => {
    const msg = { type: "floor-sat", memberId: "m1", on: true };
    expect(parseServerMessage(JSON.stringify(msg))).toEqual(msg);
    rejects(ServerMessageSchema, { type: "floor-sat", memberId: "m1", on: "yes" });
    rejects(ServerMessageSchema, { type: "floor-sat", on: true });
  });

  test("a member may carry floorSit (absent means false)", () => {
    const member = { id: "m1", nickname: "alice", avatar: 0 };
    expect(v.parse(MemberSchema, { ...member, floorSit: true })).toEqual({ ...member, floorSit: true });
    expect(v.parse(MemberSchema, member)).toEqual(member);
    rejects(MemberSchema, { ...member, floorSit: 1 });
  });
});

describe("room mood", () => {
  test("four moods, none first", () => {
    expect(ROOM_MOODS).toEqual(["none", "warm", "cool", "night"]);
  });

  test("a layout takes an optional mood on input and output; absent means none", () => {
    for (const mood of ROOM_MOODS) {
      const layout = { ...DEFAULT_LAYOUT, mood };
      expect(v.parse(RoomLayoutInputSchema, layout)).toEqual(layout);
      expect(v.parse(RoomLayoutSchema, layout)).toEqual(layout);
    }
    expect(v.parse(RoomLayoutSchema, DEFAULT_LAYOUT)).not.toHaveProperty("mood");
  });

  test.each([["dark"], ["Warm"], [""], [null], [0]])("refuses mood %p", (mood) => {
    rejects(RoomLayoutInputSchema, { ...DEFAULT_LAYOUT, mood });
    rejects(RoomLayoutSchema, { ...DEFAULT_LAYOUT, mood });
  });

  test("layout-set carries it", () => {
    const msg = { type: "layout-set", layout: { ...DEFAULT_LAYOUT, mood: "night" } };
    expect(parseClientMessage(JSON.stringify(msg))).toEqual(msg);
  });
});
