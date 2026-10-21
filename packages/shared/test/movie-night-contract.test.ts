import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  COUNTDOWN_MAX_MS,
  FURNITURE,
  MAX_POSITION_S,
  PlaybackStateSchema,
  QueueItemSchema,
  REACTIONS_MAX,
  REACTION_KINDS,
  RoomLayoutInputSchema,
  RoomSummarySchema,
  SCREEN_KINDS,
  ServerMessageSchema,
  ShareRequestSchema,
  isScreen,
  nowPlayingOf,
  parseClientMessage,
  type AnyEmbed,
} from "../src/index";

// Movie night contract B (OME-1625, ADR 0056): timed reactions, the watching summary, a share's start time,
// the shared 3-2-1 countdown and the theatre furniture kinds.

const ok = (schema: v.GenericSchema, input: unknown): boolean => v.safeParse(schema, input).success;
const MAX_MEDIA_MS = MAX_POSITION_S * 1000;

const YT: AnyEmbed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
const ROOM = { id: "lobby", seats: Array.from({ length: 8 }, () => null), members: [{ id: "m1", nickname: "alice", avatar: 0 }], embed: null, playback: null };
const snapshot = (extra: Record<string, unknown>): unknown => ({ type: "snapshot", self: "m1", room: ROOM, ...extra });
const reaction = (i: number): unknown => ({ memberId: "m1", kind: "heart", mediaMs: i });

describe("reactions", () => {
  test("the glyph set is heart, laugh, wow and clap", () => {
    expect(REACTION_KINDS).toEqual(["heart", "laugh", "wow", "clap"]);
    expect(REACTIONS_MAX).toBe(256);
  });

  test.each(REACTION_KINDS.map((k) => [k]))("react %p is a client message", (kind) => {
    expect(parseClientMessage(JSON.stringify({ type: "react", kind }))).toEqual({ type: "react", kind });
  });

  test("react carries no client time and only glyph kinds", () => {
    for (const bad of [{ kind: "wave" }, { kind: "Heart" }, {}, { kind: "heart", mediaMs: 1000 }, { kind: "heart", at: 1 }]) {
      expect(parseClientMessage(JSON.stringify({ type: "react", ...bad }))).toBeNull();
    }
  });

  test("reacted carries the server's media time, 0..MAX_POSITION_S in ms", () => {
    for (const mediaMs of [0, 61_500, MAX_MEDIA_MS]) expect(ok(ServerMessageSchema, { type: "reacted", memberId: "m1", kind: "wow", mediaMs })).toBe(true);
    for (const mediaMs of [-1, MAX_MEDIA_MS + 1, 1.5, "1", null]) expect(ok(ServerMessageSchema, { type: "reacted", memberId: "m1", kind: "wow", mediaMs })).toBe(false);
    expect(ok(ServerMessageSchema, { type: "reacted", memberId: "m1", kind: "wave", mediaMs: 0 })).toBe(false);
  });

  test("a relay batch can carry reactions", () => {
    expect(ok(ServerMessageSchema, { type: "batch", msgs: [{ type: "reacted", memberId: "m1", kind: "clap", mediaMs: 5 }] })).toBe(true);
  });

  test("the snapshot holds at most REACTIONS_MAX reactions for the current item, and the item's peak", () => {
    const n = (k: number): unknown[] => Array.from({ length: k }, (_, i) => reaction(i));
    expect(ok(ServerMessageSchema, snapshot({ reactions: n(REACTIONS_MAX), peakMembers: 25 }))).toBe(true);
    expect(ok(ServerMessageSchema, snapshot({ reactions: [] }))).toBe(true);
    expect(ok(ServerMessageSchema, snapshot({ reactions: n(REACTIONS_MAX + 1) }))).toBe(false);
    expect(ok(ServerMessageSchema, snapshot({ peakMembers: 26 }))).toBe(false);
    expect(ok(ServerMessageSchema, snapshot({ reactions: [{ memberId: "m1", kind: "heart", mediaMs: -1 }] }))).toBe(false);
  });
});

describe("rooms summary", () => {
  const ROW = { id: "lobby", memberCount: 3, seatedCount: 2 };

  test("watchingCount is at most memberCount", () => {
    expect(ok(RoomSummarySchema, { ...ROW, watchingCount: 3 })).toBe(true);
    expect(ok(RoomSummarySchema, { ...ROW, watchingCount: 0 })).toBe(true);
    expect(ok(RoomSummarySchema, { ...ROW, watchingCount: 4 })).toBe(false);
    expect(ok(RoomSummarySchema, { ...ROW, watchingCount: -1 })).toBe(false);
  });

  test("nowPlaying is provider and id only: a title or url is stripped", () => {
    const out = v.parse(RoomSummarySchema, { ...ROW, nowPlaying: { provider: "youtube", id: "dQw4w9WgXcQ", title: "x", url: "https://e" } });
    expect(out.nowPlaying).toEqual({ provider: "youtube", id: "dQw4w9WgXcQ" });
  });

  test("nowPlaying ids follow their provider", () => {
    for (const np of [{ provider: "vimeo", id: "76979871" }, { provider: "twitch", id: "some_streamer" }, { provider: "twitch", id: "videos/123456" }]) {
      expect(ok(RoomSummarySchema, { ...ROW, nowPlaying: np })).toBe(true);
    }
    for (const np of [{ provider: "youtube", id: "short" }, { provider: "twitch", id: "videos/0" }, { provider: "twitch", id: "Some Streamer" }, { provider: "generic", id: "x" }, { provider: "vimeo", id: "abc" }]) {
      expect(ok(RoomSummarySchema, { ...ROW, nowPlaying: np })).toBe(false);
    }
  });

  test("nowPlayingOf names public synced videos only", () => {
    expect(nowPlayingOf(YT)).toEqual({ provider: "youtube", id: "dQw4w9WgXcQ" });
    expect(nowPlayingOf({ provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" })).toEqual({ provider: "vimeo", id: "76979871" });
    expect(nowPlayingOf({ provider: "vimeo", videoId: "76979871", hash: "abcdef12", url: "https://player.vimeo.com/video/76979871?h=abcdef12" })).toBeUndefined();
    expect(nowPlayingOf({ provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" })).toEqual({ provider: "twitch", id: "some_streamer" });
    expect(nowPlayingOf({ provider: "twitch", kind: "vod", videoId: "123456", url: "https://player.twitch.tv/?video=v123456" })).toEqual({ provider: "twitch", id: "videos/123456" });
    expect(nowPlayingOf({ provider: "generic", host: "player.example.com", url: "https://player.example.com/embed/42" })).toBeUndefined();
    expect(nowPlayingOf(null)).toBeUndefined();
  });
});

describe("share start time", () => {
  test("startSeconds is an integer in 0..MAX_POSITION_S on the share body and the queue item", () => {
    const item = { id: "q1", embed: YT, by: null };
    for (const startSeconds of [0, 90, MAX_POSITION_S]) {
      expect(ok(ShareRequestSchema, { url: "https://youtu.be/dQw4w9WgXcQ", startSeconds })).toBe(true);
      expect(ok(QueueItemSchema, { ...item, startSeconds })).toBe(true);
    }
    for (const startSeconds of [-1, MAX_POSITION_S + 1, 1.5, "90", null]) {
      expect(ok(ShareRequestSchema, { url: "https://youtu.be/dQw4w9WgXcQ", startSeconds })).toBe(false);
      expect(ok(QueueItemSchema, { ...item, startSeconds })).toBe(false);
    }
  });
});

describe("countdown", () => {
  const AT = 1_790_000_000_000;
  const PLAY = { playing: true, position: 0, rate: 1, at: AT, rev: 2, action: "play", by: "m1" };

  test("control may ask for a countdown", () => {
    const control = { type: "control", url: YT.url, playing: true, position: 0, countdown: true } as const;
    expect(parseClientMessage(JSON.stringify(control))).toEqual(control);
    expect(parseClientMessage(JSON.stringify({ ...control, countdown: 1 }))).toBeNull();
  });

  test("startAt is on a play only, at most COUNTDOWN_MAX_MS after at", () => {
    expect(COUNTDOWN_MAX_MS).toBe(5000);
    for (const startAt of [AT, AT + 3000, AT + COUNTDOWN_MAX_MS]) expect(ok(PlaybackStateSchema, { ...PLAY, startAt })).toBe(true);
    for (const startAt of [AT - 1, AT + COUNTDOWN_MAX_MS + 1, 1.5]) expect(ok(PlaybackStateSchema, { ...PLAY, startAt })).toBe(false);
    expect(ok(PlaybackStateSchema, { ...PLAY, playing: false, action: "pause", startAt: AT + 3000 })).toBe(false);
    expect(ok(PlaybackStateSchema, { ...PLAY, action: "seek", startAt: AT + 3000 })).toBe(false);
  });
});

describe("theatre furniture", () => {
  const CHAIRS = ([[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]] as const).map(([col, row]) => ({ kind: "armchair", col, row, facing: "ne" }));
  const TV = { kind: "tv", col: 0, row: 0, facing: "se" };
  const BIG = { kind: "bigscreen", col: 0, row: 0, facing: "se" };

  test("the five theatre kinds, as agreed with the Designer (OME-1639)", () => {
    expect(FURNITURE.theatrerow).toMatchObject({ layer: "object", facings: ["ne", "nw"], cols: 2, rows: 1, seats: true, variants: 3 });
    expect(FURNITURE.curtain).toMatchObject({ layer: "wall", facings: ["se", "sw"], cols: 0, rows: 0, seats: false, variants: 1 });
    expect(FURNITURE.bigscreen).toMatchObject({ layer: "object", facings: ["se"], cols: 1, rows: 1, seats: false });
    expect(FURNITURE.aislelight).toMatchObject({ layer: "floor", facings: ["ne", "nw"], cols: 1, rows: 1 });
    expect(FURNITURE.carpet).toMatchObject({ layer: "floor", facings: ["se"], cols: 2, rows: 2 });
  });

  test("a layout has exactly one screen: a tv or a bigscreen", () => {
    expect(SCREEN_KINDS).toEqual(["tv", "bigscreen"]);
    expect(isScreen("bigscreen") && isScreen("tv") && !isScreen("lamp")).toBe(true);
    expect(ok(RoomLayoutInputSchema, { furniture: [BIG, ...CHAIRS] })).toBe(true);
    expect(ok(RoomLayoutInputSchema, { furniture: [TV, ...CHAIRS] })).toBe(true);
    expect(ok(RoomLayoutInputSchema, { furniture: [TV, { ...BIG, col: 9, row: 9 }, ...CHAIRS] })).toBe(false);
    expect(ok(RoomLayoutInputSchema, { furniture: [...CHAIRS] })).toBe(false);
  });

  test("a theatre: 4 raised rows seat 8, curtains on both walls, carpet and aisle lights apart", () => {
    const rows = [[2, 5, 0], [5, 2, 0], [2, 7, 1], [5, 4, 2]].map(([col, row, variant]) => ({ kind: "theatrerow", col, row, facing: "ne", variant }));
    const furniture = [
      BIG,
      ...rows,
      { kind: "curtain", col: 1, row: 0, facing: "sw" },
      { kind: "curtain", col: 0, row: 1, facing: "se" },
      { kind: "carpet", col: 2, row: 5, facing: "se" },
      { kind: "aislelight", col: 1, row: 1, facing: "ne" },
    ];
    expect(ok(RoomLayoutInputSchema, { furniture })).toBe(true);
    expect(ok(RoomLayoutInputSchema, { furniture: [...furniture, { kind: "aislelight", col: 3, row: 6, facing: "ne" }] })).toBe(false);
    expect(ok(RoomLayoutInputSchema, { furniture: [BIG, ...rows.slice(0, 3), ...CHAIRS.slice(0, 2)] })).toBe(true);
    expect(ok(RoomLayoutInputSchema, { furniture: furniture.map((f) => (f.kind === "theatrerow" ? { ...f, variant: 3 } : f)) })).toBe(false);
  });
});
