import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
  type Member,
  type RoomState,
} from "../src/index";

// Advisory catch-up status (OME-213, ADR 0019, docs/research/m3-threat-model.md §7.7).

function accepts(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).issues).toBeUndefined();
}
function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

const ALICE: Member = { id: "m1", nickname: "Alice", avatar: 0 };
const BOB: Member = { id: "m2", nickname: "Bob", avatar: 1 };
function room(members: Member[]): RoomState {
  return { id: "lobby", seats: [null, null, null, null, null, null, null, null], members, embed: null, playback: null };
}

describe("client status", () => {
  test("accepts catching true and false", () => {
    expect(parseClientMessage('{"type":"status","catching":true}')).toEqual({ type: "status", catching: true });
    expect(parseClientMessage('{"type":"status","catching":false}')).toEqual({ type: "status", catching: false });
  });

  test.each([
    ["missing catching", { type: "status" }],
    ["string catching", { type: "status", catching: "true" }],
    ["number catching", { type: "status", catching: 1 }],
    ["null catching", { type: "status", catching: null }],
    ["extra key", { type: "status", catching: true, memberId: "m1" }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("server member-status", () => {
  test("accepts catching true and false", () => {
    expect(parseServerMessage('{"type":"member-status","memberId":"m1","catching":true}')).toEqual({
      type: "member-status",
      memberId: "m1",
      catching: true,
    });
    accepts(ServerMessageSchema, { type: "member-status", memberId: "m1", catching: false });
  });

  test("strips unknown keys", () => {
    expect(v.parse(ServerMessageSchema, { type: "member-status", memberId: "m1", catching: true, x: 1 })).toEqual({
      type: "member-status",
      memberId: "m1",
      catching: true,
    });
  });

  test.each([
    ["missing memberId", { type: "member-status", catching: true }],
    ["bad memberId", { type: "member-status", memberId: "", catching: true }],
    ["missing catching", { type: "member-status", memberId: "m1" }],
    ["string catching", { type: "member-status", memberId: "m1", catching: "yes" }],
  ])("rejects %s", (_name, input) => {
    rejects(ServerMessageSchema, input);
  });
});

describe("members[].catching", () => {
  test("snapshot carries optional catching per member", () => {
    const parsed = v.parse(ServerMessageSchema, {
      type: "snapshot",
      self: "m2",
      room: room([{ ...ALICE, catching: true }, BOB]),
    });
    expect(parsed).toEqual({ type: "snapshot", self: "m2", room: room([{ ...ALICE, catching: true }, BOB]) });
  });

  test("catching false is kept", () => {
    const parsed = v.parse(ServerMessageSchema, { type: "member-joined", member: { ...ALICE, catching: false } });
    expect(parsed).toEqual({ type: "member-joined", member: { ...ALICE, catching: false } });
  });

  test("rejects a non-boolean catching", () => {
    rejects(ServerMessageSchema, { type: "snapshot", self: "m1", room: { ...room([]), members: [{ ...ALICE, catching: "yes" }] } });
    rejects(ServerMessageSchema, { type: "member-joined", member: { ...ALICE, catching: 1 } });
  });
});
