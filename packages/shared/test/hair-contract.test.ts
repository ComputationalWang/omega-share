import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { ClientMessageSchema, HAIR_COUNT, MemberSchema, ServerMessageSchema, parseClientMessage, parseServerMessage } from "../src/index";

// Member hair colour (OME-1435, ADR 0053 amendment): works exactly like tint.

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

test("six hair colours, 0 today's look", () => {
  expect(HAIR_COUNT).toBe(6);
});

describe("client set-hair", () => {
  test("accepts every hair", () => {
    for (let hair = 0; hair < HAIR_COUNT; hair++) {
      expect(parseClientMessage(JSON.stringify({ type: "set-hair", hair }))).toEqual({ type: "set-hair", hair });
    }
  });

  test.each([[HAIR_COUNT], [-1], [0.5], ["1"], [null]])("rejects %p", (hair) => {
    rejects(ClientMessageSchema, { type: "set-hair", hair });
  });

  test("rejects an extra key", () => {
    rejects(ClientMessageSchema, { type: "set-hair", hair: 1, memberId: "m1" });
  });

  test("join takes an optional hair", () => {
    const join = { type: "join" as const, nickname: "alice", avatar: 0 };
    expect(parseClientMessage(JSON.stringify({ ...join, hair: 5 }))).toEqual({ ...join, hair: 5 });
    expect(parseClientMessage(JSON.stringify(join))).toEqual(join);
    rejects(ClientMessageSchema, { ...join, hair: 6 });
    rejects(ClientMessageSchema, { ...join, hair: null });
  });
});

describe("server hair-changed", () => {
  test("carries a bounded hair", () => {
    expect(parseServerMessage(JSON.stringify({ type: "hair-changed", memberId: "m1", hair: 5 }))).toEqual({ type: "hair-changed", memberId: "m1", hair: 5 });
    rejects(ServerMessageSchema, { type: "hair-changed", memberId: "m1", hair: 6 });
  });

  test("a member may carry a hair (absent means 0)", () => {
    const member = { id: "m1", nickname: "alice", avatar: 0 };
    expect(v.parse(MemberSchema, { ...member, hair: 2 })).toEqual({ ...member, hair: 2 });
    rejects(MemberSchema, { ...member, hair: 6 });
  });
});
