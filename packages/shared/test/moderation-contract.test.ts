import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  CLOSE_CODES,
  CONTROL_POLICIES,
  ClientMessageSchema,
  DEFAULT_CONTROL_POLICY,
  ERROR_CODES,
  KICK_COOLDOWN_MS,
  MEMBER_LEFT_REASONS,
  MODERATION_BURST,
  MODERATION_REFILL_MS,
  MUTE_MEMORY_MS,
  SHARE_ERROR_CODES,
  ServerMessageSchema,
  ShareResponseSchema,
  parseClientMessage,
  parseServerMessage,
  type Member,
  type RoomState,
} from "../src/index";

// Owner moderation (OME-502, M6 C1, ADR 0030): kick, mute, control policy.

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

const OVERSIZE_ID = "a".repeat(65);
const SEATS = [null, null, null, null, null, null, null, null];
const alice: Member = { id: "m1", nickname: "Alice", avatar: 0 };
const room: RoomState = { id: "lobby", seats: SEATS, members: [alice], embed: null, playback: null };

describe("client kick", () => {
  test("accepts a member id", () => {
    expect(parseClientMessage('{"type":"kick","memberId":"m2"}')).toEqual({ type: "kick", memberId: "m2" });
  });

  test.each([
    ["missing memberId", { type: "kick" }],
    ["empty memberId", { type: "kick", memberId: "" }],
    ["oversize memberId", { type: "kick", memberId: OVERSIZE_ID }],
    ["memberId with a slash", { type: "kick", memberId: "m/2" }],
    ["number memberId", { type: "kick", memberId: 2 }],
    ["extra key", { type: "kick", memberId: "m2", reason: "spam" }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("client mute", () => {
  test.each([true, false])("accepts muted: %p", (muted) => {
    expect(parseClientMessage(JSON.stringify({ type: "mute", memberId: "m2", muted }))).toEqual({
      type: "mute",
      memberId: "m2",
      muted,
    });
  });

  test.each([
    ["missing muted", { type: "mute", memberId: "m2" }],
    ["string muted", { type: "mute", memberId: "m2", muted: "true" }],
    ["missing memberId", { type: "mute", muted: true }],
    ["oversize memberId", { type: "mute", memberId: OVERSIZE_ID, muted: true }],
    ["extra key", { type: "mute", memberId: "m2", muted: true, forMs: 60_000 }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("client control-policy", () => {
  test("policies are everyone and owner; the default is everyone (today's behaviour)", () => {
    expect([...CONTROL_POLICIES]).toEqual(["everyone", "owner"]);
    expect(DEFAULT_CONTROL_POLICY).toBe("everyone");
  });

  test.each(["everyone", "owner"])("accepts %s", (policy) => {
    expect(parseClientMessage(JSON.stringify({ type: "control-policy", policy }))).toEqual({
      type: "control-policy",
      policy,
    });
  });

  test.each([
    ["unknown policy", { type: "control-policy", policy: "nobody" }],
    ["upper-case policy", { type: "control-policy", policy: "Owner" }],
    ["missing policy", { type: "control-policy" }],
    ["extra key", { type: "control-policy", policy: "owner", memberId: "m1" }],
  ])("rejects %s", (_name, input) => {
    rejects(ClientMessageSchema, input);
  });
});

describe("server member-left reason", () => {
  test.each(MEMBER_LEFT_REASONS.map((r) => [r]))("accepts %s", (reason) => {
    expect(parseServerMessage(JSON.stringify({ type: "member-left", memberId: "m2", reason }))).toEqual({
      type: "member-left",
      memberId: "m2",
      reason,
    });
  });

  test("reasons are left and kicked", () => {
    expect([...MEMBER_LEFT_REASONS]).toEqual(["left", "kicked"]);
  });

  test("absent from a pre-M6 server (read as left)", () => {
    expect(parseServerMessage('{"type":"member-left","memberId":"m2"}')).toEqual({ type: "member-left", memberId: "m2" });
  });

  test("rejects an unknown reason", () => {
    rejects(ServerMessageSchema, { type: "member-left", memberId: "m2", reason: "banned" });
  });
});

describe("server member-muted", () => {
  test.each([true, false])("accepts muted: %p", (muted) => {
    expect(parseServerMessage(JSON.stringify({ type: "member-muted", memberId: "m2", muted }))).toEqual({
      type: "member-muted",
      memberId: "m2",
      muted,
    });
  });

  test.each([
    ["missing muted", { type: "member-muted", memberId: "m2" }],
    ["oversize memberId", { type: "member-muted", memberId: OVERSIZE_ID, muted: true }],
  ])("rejects %s", (_name, input) => {
    rejects(ServerMessageSchema, input);
  });
});

describe("server control-policy-changed", () => {
  test.each(["everyone", "owner"])("accepts %s", (policy) => {
    expect(parseServerMessage(JSON.stringify({ type: "control-policy-changed", policy, by: "m1" }))).toEqual({
      type: "control-policy-changed",
      policy,
      by: "m1",
    });
  });

  test.each([
    ["unknown policy", { type: "control-policy-changed", policy: "nobody", by: "m1" }],
    ["missing by", { type: "control-policy-changed", policy: "owner" }],
  ])("rejects %s", (_name, input) => {
    rejects(ServerMessageSchema, input);
  });
});

describe("room state", () => {
  test("a member carries muted", () => {
    const parsed = v.parse(ServerMessageSchema, {
      type: "snapshot",
      self: "m1",
      room: { ...room, members: [{ ...alice, muted: true }] },
    });
    expect(parsed).toEqual({ type: "snapshot", self: "m1", room: { ...room, members: [{ ...alice, muted: true }] } });
  });

  test("the snapshot carries the control policy", () => {
    const parsed = v.parse(ServerMessageSchema, { type: "snapshot", self: "m1", room: { ...room, controlPolicy: "owner" } });
    expect(parsed).toEqual({ type: "snapshot", self: "m1", room: { ...room, controlPolicy: "owner" } });
  });

  test("both are absent from a pre-M6 server (read as not muted, everyone)", () => {
    expect(v.parse(ServerMessageSchema, { type: "snapshot", self: "m1", room })).toEqual({ type: "snapshot", self: "m1", room });
  });

  test.each([
    ["string muted", { ...room, members: [{ ...alice, muted: "yes" }] }],
    ["unknown policy", { ...room, controlPolicy: "nobody" }],
  ])("rejects %s", (_name, badRoom) => {
    rejects(ServerMessageSchema, { type: "snapshot", self: "m1", room: badRoom });
  });
});

describe("errors", () => {
  test.each(["muted", "control_owner_only", "bad_target"])("WS error code %s", (code) => {
    expect(ERROR_CODES).toContain(code);
    expect(parseServerMessage(JSON.stringify({ type: "error", code, message: "no" }))).toEqual({
      type: "error",
      code,
      message: "no",
    });
  });

  test("a share under the owner-only policy is refused with control_owner_only", () => {
    expect(SHARE_ERROR_CODES).toContain("control_owner_only");
    expect(
      v.parse(ShareResponseSchema, { ok: false, error: { code: "control_owner_only", message: "owner only" } }),
    ).toEqual({ ok: false, error: { code: "control_owner_only", message: "owner only" } });
  });
});

describe("kicked close code and limits", () => {
  test("KICKED is 4005, the next free code after ROOM_CLOSED (4004)", () => {
    expect(CLOSE_CODES.KICKED).toBe(4005);
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("a kick keeps the address out of the room for 10 min; a mute outlives a reconnect as long", () => {
    expect(KICK_COOLDOWN_MS).toBe(10 * 60_000);
    expect(MUTE_MEMORY_MS).toBe(10 * 60_000);
  });

  test("moderation frames have their own owner bucket: 5 at once, then one a second", () => {
    expect(MODERATION_BURST).toBe(5);
    expect(MODERATION_REFILL_MS).toBe(1000);
  });
});
