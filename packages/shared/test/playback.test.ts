import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  ClientMessageSchema,
  ERROR_CODES,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_POSITION_S,
  MAX_SERVER_MESSAGE_BYTES,
  PING_ID_MAX,
  PLAYBACK_ACTIONS,
  PlaybackStateSchema,
  PositionSchema,
  RoomStateSchema,
  ServerMessageSchema,
  parseClientMessage,
  parseServerMessage,
  type Embed,
  type PlaybackState,
  type RoomState,
} from "../src/index";

const VIDEO_ID = "dQw4w9WgXcQ";
const EMBED: Embed = { provider: "youtube", videoId: VIDEO_ID, url: `https://www.youtube.com/embed/${VIDEO_ID}` };
const PLAYBACK: PlaybackState = { playing: true, position: 12.5, rate: 1, at: 1_790_000_000_000, rev: 3, action: "play", by: "m1" };
const LOADED: PlaybackState = { playing: true, position: 0, rate: 1, at: 1_790_000_000_000, rev: 0, action: "load", by: null };
const seats = (): (string | null)[] => Array.from({ length: 8 }, () => null);

function room(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: "lobby", seats: seats(), members: [{ id: "m1", nickname: "alice", avatar: 0 }], embed: EMBED, playback: PLAYBACK, ...overrides };
}

function cases(schema: v.GenericSchema, valid: readonly unknown[], invalid: readonly [string, unknown][]): void {
  for (const input of valid) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      expect(v.safeParse(schema, input).issues).toBeUndefined();
    });
  }
  for (const [name, input] of invalid) {
    test(`rejects ${name}`, () => {
      expect(v.safeParse(schema, input).success).toBe(false);
    });
  }
}

const utf8 = (s: string): number => new TextEncoder().encode(s).length;

describe("playback constants", () => {
  test("M1b values", () => {
    expect(MAX_POSITION_S).toBe(43_200);
    expect(PING_ID_MAX).toBe(2_147_483_647);
    expect(PLAYBACK_ACTIONS).toEqual(["play", "pause", "seek", "load"]);
    expect(ERROR_CODES).toContain("no_embed");
  });
});

describe("PositionSchema", () => {
  cases(PositionSchema, [0, 0.001, 12.5, 43_200], [
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["negative", -0.5],
    ["above MAX_POSITION_S", 43_200.001],
    ["string", "12"],
    ["null", null],
  ]);
});

describe("PlaybackStateSchema", () => {
  cases(
    PlaybackStateSchema,
    [
      PLAYBACK,
      LOADED,
      { ...PLAYBACK, playing: false, action: "pause" },
      { ...PLAYBACK, action: "seek", position: 43_200 },
      { ...PLAYBACK, rate: 0.25 },
      { ...PLAYBACK, rate: 2 },
    ],
    [
      ["rate below 0.25", { ...PLAYBACK, rate: 0.24 }],
      ["rate above 2", { ...PLAYBACK, rate: 2.01 }],
      ["rate 0", { ...PLAYBACK, rate: 0 }],
      ["rate NaN", { ...PLAYBACK, rate: Number.NaN }],
      ["position NaN", { ...PLAYBACK, position: Number.NaN }],
      ["position negative", { ...PLAYBACK, position: -1 }],
      ["position too large", { ...PLAYBACK, position: 43_201 }],
      ["fractional at", { ...PLAYBACK, at: 1.5 }],
      ["negative at", { ...PLAYBACK, at: -1 }],
      ["fractional rev", { ...PLAYBACK, rev: 0.5 }],
      ["negative rev", { ...PLAYBACK, rev: -1 }],
      ["unknown action", { ...PLAYBACK, action: "stop" }],
      ["bad by", { ...PLAYBACK, by: "../x" }],
      ["missing by", { playing: true, position: 0, rate: 1, at: 0, rev: 0, action: "load" }],
      ["playing as string", { ...PLAYBACK, playing: "true" }],
    ],
  );

  test("strips unknown keys", () => {
    expect(v.parse(PlaybackStateSchema, { ...PLAYBACK, duration: 300 })).toEqual(PLAYBACK);
  });
});

describe("ClientMessageSchema: ping and control", () => {
  cases(
    ClientMessageSchema,
    [
      { type: "ping", id: 0 },
      { type: "ping", id: 2_147_483_647 },
      { type: "control", videoId: VIDEO_ID, playing: true, position: 0 },
      { type: "control", videoId: VIDEO_ID, playing: false, position: 43_200 },
    ],
    [
      ["ping without id", { type: "ping" }],
      ["ping negative id", { type: "ping", id: -1 }],
      ["ping fractional id", { type: "ping", id: 1.5 }],
      ["ping id above PING_ID_MAX", { type: "ping", id: 2_147_483_648 }],
      ["ping with unknown key", { type: "ping", id: 1, t0: 5 }],
      ["control with unknown key", { type: "control", videoId: VIDEO_ID, playing: true, position: 0, rate: 2 }],
      ["control NaN position", { type: "control", videoId: VIDEO_ID, playing: true, position: Number.NaN }],
      ["control negative position", { type: "control", videoId: VIDEO_ID, playing: true, position: -1 }],
      ["control position above MAX_POSITION_S", { type: "control", videoId: VIDEO_ID, playing: true, position: 43_201 }],
      ["control bad videoId", { type: "control", videoId: "short", playing: true, position: 0 }],
      ["control reserved videoId", { type: "control", videoId: "videoseries", playing: true, position: 0 }],
      ["control missing playing", { type: "control", videoId: VIDEO_ID, position: 0 }],
      ["server-only pong", { type: "pong", id: 1, at: 0 }],
      ["server-only playback", { type: "playback", playback: PLAYBACK }],
    ],
  );

  test("parseClientMessage rejects NaN smuggled as a JSON number overflow", () => {
    // JSON has no NaN; 1e999 parses to Infinity.
    expect(parseClientMessage(`{"type":"control","videoId":"${VIDEO_ID}","playing":true,"position":1e999}`)).toBeNull();
  });

  test("a worst-case control frame stays under the client frame cap", () => {
    const frame = JSON.stringify({ type: "control", videoId: "_".repeat(11), playing: false, position: 43_199.999_999_999_99 });
    expect(utf8(frame)).toBeLessThan(MAX_CLIENT_MESSAGE_BYTES);
    expect(parseClientMessage(frame)?.type).toBe("control");
  });
});

describe("ServerMessageSchema: pong and playback", () => {
  cases(
    ServerMessageSchema,
    [
      { type: "pong", id: 7, at: 1_790_000_000_000 },
      { type: "playback", playback: PLAYBACK },
      { type: "playback", playback: LOADED },
      { type: "embed-changed", embed: EMBED, by: null, playback: LOADED },
      { type: "embed-changed", embed: null, by: "m1", playback: null },
      { type: "error", code: "no_embed", message: "no video to control" },
    ],
    [
      ["pong without at", { type: "pong", id: 7 }],
      ["pong id above PING_ID_MAX", { type: "pong", id: 2_147_483_648, at: 0 }],
      ["pong fractional at", { type: "pong", id: 7, at: 0.5 }],
      ["playback null", { type: "playback", playback: null }],
      ["playback with bad rate", { type: "playback", playback: { ...PLAYBACK, rate: 4 } }],
      ["embed-changed with playback but no embed", { type: "embed-changed", embed: null, by: null, playback: LOADED }],
      ["client-only ping", { type: "ping", id: 1 }],
      ["client-only control", { type: "control", videoId: VIDEO_ID, playing: true, position: 0 }],
    ],
  );

  test("strips unknown keys on pong and playback", () => {
    expect(v.parse(ServerMessageSchema, { type: "pong", id: 1, at: 2, rtt: 3 })).toEqual({ type: "pong", id: 1, at: 2 });
    expect(v.parse(ServerMessageSchema, { type: "playback", playback: { ...PLAYBACK, extra: 1 }, seq: 9 })).toEqual({
      type: "playback",
      playback: PLAYBACK,
    });
  });

  test("a v0 embed-changed without playback still parses, with playback absent", () => {
    const msg = v.parse(ServerMessageSchema, { type: "embed-changed", embed: EMBED, by: null });
    expect(msg).toEqual({ type: "embed-changed", embed: EMBED, by: null });
  });
});

describe("RoomStateSchema.playback", () => {
  cases(
    RoomStateSchema,
    [room(), room({ embed: null, playback: null }), room({ playback: LOADED })],
    [
      ["playback without embed", room({ embed: null })],
      ["invalid playback", room({ playback: { ...PLAYBACK, position: -1 } })],
    ],
  );

  test("a v0 snapshot without playback still parses, with playback absent", () => {
    const v0: RoomState = { id: "lobby", seats: seats(), members: [], embed: EMBED };
    const frame = JSON.stringify({ type: "snapshot", self: "m1", room: v0 });
    const msg = parseServerMessage(frame);
    expect(msg?.type === "snapshot" ? msg.room : null).toEqual(v0);
  });

  test("a worst-case 25-member snapshot with playback stays under the server frame cap", () => {
    const members = Array.from({ length: 25 }, (_, i) => ({
      id: String(i).padStart(2, "0") + "x".repeat(62),
      nickname: "李".repeat(20),
      avatar: 3,
    }));
    const worstPlayback: PlaybackState = { playing: false, position: 43_199.999_999_999_99, rate: 1.999_999_999_999, at: 9_007_199_254_740_991, rev: 9_007_199_254_740_991, action: "pause", by: "z".repeat(64) };
    const frame = JSON.stringify({
      type: "snapshot",
      self: members[0]?.id,
      room: { id: "a".repeat(32), seats: members.slice(0, 8).map((m) => m.id), members, embed: EMBED, playback: worstPlayback },
    });
    expect(utf8(frame)).toBeLessThan(MAX_SERVER_MESSAGE_BYTES);
    const msg = parseServerMessage(frame);
    expect(msg?.type === "snapshot" ? msg.room.playback : null).toEqual(worstPlayback);
  });
});
