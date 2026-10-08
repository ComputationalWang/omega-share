import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  EMOTE_BURST,
  EMOTE_KINDS,
  EMOTE_REFILL_MS,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
  type Member,
  type RoomState,
} from "../src/index";

// Emotes and wave (OME-413, M5 C2): fire-and-forget, never stored, never in a snapshot.

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("EMOTE_KINDS", () => {
  test("is the atlas emotes plus wave", () => {
    expect([...EMOTE_KINDS].sort()).toEqual(["clap", "exclaim", "heart", "laugh", "question", "wave"]);
  });
});

describe("client emote", () => {
  test.each(EMOTE_KINDS.map((k) => [k]))("accepts %s", (kind) => {
    expect(parseClientMessage(JSON.stringify({ type: "emote", kind }))).toEqual({ type: "emote", kind });
  });

  test.each([
    ["unknown kind", { type: "emote", kind: "dance" }],
    ["avatar name as kind", { type: "emote", kind: "pip" }],
    ["upper-case kind", { type: "emote", kind: "Wave" }],
    ["missing kind", { type: "emote" }],
    ["number kind", { type: "emote", kind: 0 }],
    ["extra key", { type: "emote", kind: "wave", memberId: "m1" }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("server emoted", () => {
  test("accepts every kind", () => {
    for (const kind of EMOTE_KINDS) {
      expect(parseServerMessage(JSON.stringify({ type: "emoted", memberId: "m1", kind }))).toEqual({
        type: "emoted",
        memberId: "m1",
        kind,
      });
    }
  });

  test("strips unknown keys", () => {
    expect(v.parse(ServerMessageSchema, { type: "emoted", memberId: "m1", kind: "clap", at: 1 })).toEqual({
      type: "emoted",
      memberId: "m1",
      kind: "clap",
    });
  });

  test.each([
    ["missing memberId", { type: "emoted", kind: "wave" }],
    ["bad memberId", { type: "emoted", memberId: "", kind: "wave" }],
    ["unknown kind", { type: "emoted", memberId: "m1", kind: "dance" }],
    ["missing kind", { type: "emoted", memberId: "m1" }],
  ])("rejects %s", (_name, input) => {
    rejects(ServerMessageSchema, input);
  });

  test("is not replayed in a snapshot: room state has no emote field", () => {
    const alice: Member = { id: "m1", nickname: "Alice", avatar: 0 };
    const room: RoomState = { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [alice], embed: null, playback: null };
    const parsed = v.parse(ServerMessageSchema, {
      type: "snapshot",
      self: "m1",
      room: { ...room, emotes: [{ memberId: "m1", kind: "wave" }], members: [{ ...alice, emote: "wave" }] },
    });
    expect(parsed).toEqual({ type: "snapshot", self: "m1", room });
  });
});

describe("emote rate limit", () => {
  test("per member: burst 3, then one a second", () => {
    expect(EMOTE_BURST).toBe(3);
    expect(EMOTE_REFILL_MS).toBe(1000);
  });
});
