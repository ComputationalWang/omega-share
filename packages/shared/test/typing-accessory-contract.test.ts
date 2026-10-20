import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ACCESSORY_COUNT,
  ClientMessageSchema,
  MemberSchema,
  ServerMessageSchema,
  TYPING_BURST,
  TYPING_REFILL_MS,
  TYPING_TIMEOUT_MS,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

// Typing indicator and avatar accessory (OME-1387, ADR 0053 amendment).

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("constants", () => {
  test("typing is 1/s with a burst of 2 and times out after 5 s; nine accessories, 0 none (OME-1532)", () => {
    expect([TYPING_BURST, TYPING_REFILL_MS, TYPING_TIMEOUT_MS, ACCESSORY_COUNT]).toEqual([2, 1000, 5000, 9]);
  });
});

describe("client typing", () => {
  test("accepts on and off", () => {
    for (const on of [true, false]) expect(parseClientMessage(JSON.stringify({ type: "typing", on }))).toEqual({ type: "typing", on });
  });

  test.each([[1], ["true"], [null], [undefined]])("rejects on: %p", (on) => {
    rejects(ClientMessageSchema, { type: "typing", on });
  });

  test("rejects an extra key", () => {
    rejects(ClientMessageSchema, { type: "typing", on: true, memberId: "m1" });
  });
});

describe("client set-accessory", () => {
  test("accepts every accessory", () => {
    for (let accessory = 0; accessory < ACCESSORY_COUNT; accessory++) {
      expect(parseClientMessage(JSON.stringify({ type: "set-accessory", accessory }))).toEqual({ type: "set-accessory", accessory });
    }
  });

  test.each([[ACCESSORY_COUNT], [-1], [0.5], ["1"], [null]])("rejects %p", (accessory) => {
    rejects(ClientMessageSchema, { type: "set-accessory", accessory });
  });

  test("join takes an optional accessory", () => {
    const join = { type: "join" as const, nickname: "alice", avatar: 0 };
    expect(parseClientMessage(JSON.stringify({ ...join, accessory: 4 }))).toEqual({ ...join, accessory: 4 });
    expect(parseClientMessage(JSON.stringify(join))).toEqual(join);
    rejects(ClientMessageSchema, { ...join, accessory: 9 });
    rejects(ClientMessageSchema, { ...join, accessory: null });
  });
});

describe("server typing-changed and accessory-changed", () => {
  test("typing-changed carries the member and on", () => {
    for (const on of [true, false]) {
      expect(parseServerMessage(JSON.stringify({ type: "typing-changed", memberId: "m1", on }))).toEqual({ type: "typing-changed", memberId: "m1", on });
    }
    expect(parseServerMessage(JSON.stringify({ type: "typing-changed", memberId: "m1" }))).toBeNull();
    rejects(ServerMessageSchema, { type: "typing-changed", memberId: "m1", on: 1 });
  });

  test("accessory-changed carries a bounded accessory", () => {
    expect(parseServerMessage(JSON.stringify({ type: "accessory-changed", memberId: "m1", accessory: 4 }))).toEqual({ type: "accessory-changed", memberId: "m1", accessory: 4 });
    rejects(ServerMessageSchema, { type: "accessory-changed", memberId: "m1", accessory: 9 });
  });

  test("a member may carry an accessory (absent means 0) and never a typing flag", () => {
    const member = { id: "m1", nickname: "alice", avatar: 0 };
    expect(v.parse(MemberSchema, { ...member, accessory: 2 })).toEqual({ ...member, accessory: 2 });
    rejects(MemberSchema, { ...member, accessory: 9 });
    expect(v.parse(MemberSchema, { ...member, typing: true })).toEqual(member);
  });
});
