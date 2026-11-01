import { expect, test } from "bun:test";
import * as v from "valibot";
import { MAX_SERVER_MESSAGE_BYTES, RoomStateSchema, CLOSE_CODES, parseClientMessage, parseServerMessage, RESUME_GRACE_MS, RESUME_STORAGE_KEY_PREFIX, RESUME_TOKEN_LENGTH, ResumeRecordSchema, ResumeTokenSchema } from "../src";

const token = "Ab_-" + "x".repeat(39);
const record = { roomId: "lobby", token, nickname: "Alice", avatar: 0 };

test("a room resume record round-trips, rejecting malformed credentials and extra storage fields", () => {
  expect(v.parse(ResumeRecordSchema, JSON.parse(JSON.stringify(record)))).toEqual(record);
  for (const bad of ["x".repeat(42), "x".repeat(44), "x".repeat(42) + "=", "x".repeat(42) + "/", "x".repeat(42) + "+", token + "\n", null, 43]) {
    expect(v.safeParse(ResumeTokenSchema, bad).success).toBe(false);
  }
  for (const bad of [{ ...record, secret: token }, { ...record, roomId: "../room" }, { ...record, nickname: "" }, { ...record, avatar: 4 }, { ...record, token: "x".repeat(22) }]) {
    expect(v.safeParse(ResumeRecordSchema, bad).success).toBe(false);
  }
  expect(RESUME_TOKEN_LENGTH).toBe(43);
  expect(RESUME_GRACE_MS).toBe(120_000);
  expect(RESUME_STORAGE_KEY_PREFIX).toBe("omega.resume.");
});

test("durable joins and presence survive wire parsing while legacy joins and snapshots remain valid", () => {
  const join = { type: "join", nickname: "Alice", avatar: 0 };
  const room = { id: "lobby", seats: Array.from({ length: 8 }, () => null), members: [{ id: "alice", nickname: "Alice", avatar: 0 }], embed: null };
  const snapshot = { type: "snapshot", self: "alice", room };
  for (const frame of [join, { ...join, durableSession: true }, { ...join, resumeToken: token }, { ...join, durableSession: true, resumeToken: token }, { ...join, avatarAuto: true }, { type: "presence", away: true }, { type: "presence", away: false }]) {
    expect(parseClientMessage(JSON.stringify(frame)) as unknown).toEqual(frame);
  }
  for (const frame of [{ ...join, durableSession: false }, { ...join, durableSession: 1 }, { ...join, avatarAuto: false }, { ...join, avatarAuto: 1 }, { ...join, avatarAuto: null }, { ...join, resumeToken: "short" }, { ...join, resumeToken: null }, { type: "presence", away: "true" }, { type: "presence" }, { type: "presence", away: false, token }, { ...join, away: true }]) {
    expect(parseClientMessage(JSON.stringify(frame)) as unknown).toBeNull();
  }
  for (const frame of [snapshot, { ...snapshot, resumeToken: token, resumed: true }, { type: "member-presence", memberId: "alice", away: false }, { type: "member-presence", memberId: "alice", away: true }, { type: "error", code: "resume_expired", message: "Session expired" }]) {
    expect(parseServerMessage(JSON.stringify(frame)) as unknown).toEqual(frame);
  }
  for (const frame of [{ ...snapshot, resumeToken: "short" }, { ...snapshot, resumed: 1 }, { type: "member-presence", memberId: "../alice", away: true }, { type: "member-presence", memberId: "alice", away: 1 }]) {
    expect(parseServerMessage(JSON.stringify(frame)) as unknown).toBeNull();
  }
  expect(CLOSE_CODES.SESSION_REPLACED).toBe(4007);
});

test("room snapshots retain bounded unique slots for seated and away members", () => {
  const members = Array.from({ length: 25 }, (_, i) => ({ id: `m${String(i)}`, nickname: `User${String(i)}`, avatar: i % 4, standingSlot: i, away: i % 2 === 0 }));
  const room = { id: "lobby", seats: members.slice(0, 8).map((m) => m.id), members, embed: null };
  const snapshot = { type: "snapshot", self: "m0", room, resumeToken: token, resumed: true };
  const raw = JSON.stringify(snapshot);
  expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(MAX_SERVER_MESSAGE_BYTES);
  expect(parseServerMessage(raw) as unknown).toEqual(snapshot);
  for (const standingSlot of [-1, 25, 0.5, null, "0"]) {
    expect(v.safeParse(RoomStateSchema, { ...room, members: [{ ...members[0], standingSlot }], seats: Array.from({ length: 8 }, () => null) }).success).toBe(false);
  }
  expect(v.safeParse(RoomStateSchema, { ...room, members: members.map((m) => ({ ...m, standingSlot: 0 })) }).success).toBe(false);
  expect(v.safeParse(RoomStateSchema, { ...room, members: [{ id: "legacy", nickname: "Legacy", avatar: 0 }, ...members], seats: Array.from({ length: 8 }, () => null) }).success).toBe(false); // Capacity includes held members.
  expect(v.safeParse(RoomStateSchema, { ...room, members: [{ id: "legacy", nickname: "Legacy", avatar: 0 }, members[0]], seats: Array.from({ length: 8 }, () => null) }).success).toBe(true);
  expect(v.safeParse(RoomStateSchema, { ...room, members: [{ ...members[0], away: "true" }], seats: Array.from({ length: 8 }, () => null) }).success).toBe(false);
});
