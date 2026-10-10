import { describe, expect, test } from "bun:test";
import { parsePopMessage, popoutSupported, popoutUrl, readPopoutHash, roomPopoutUrl } from "../src/popout/channel";

// OME-598 (M7 W3): the pop-out chat talks to its room tab over a BroadcastChannel. The channel is a boundary like the
// socket: every message is parsed (a Valibot schema local to apps/web, not wire) and anything else is dropped.

describe("pop-out channel messages", () => {
  test("the room's and the pop-out's messages parse", () => {
    const ok: unknown[] = [
      { t: "room-hello" },
      { t: "room-adopt", pop: "p1" },
      { t: "room-said", pop: "p1", seq: 3, ok: true },
      { t: "room-back" },
      { t: "room-gone" },
      {
        t: "room-log",
        reset: true,
        entries: [
          { kind: "chat", nickname: "Ada", text: "hi", self: false },
          { kind: "system", line: { glyph: "pause", actor: "Ada", verb: "paused", time: "1:02" } },
          { kind: "system", line: { glyph: "chat-mute", actor: null, verb: "The host muted your chat.", time: null, self: true } },
        ],
      },
      { t: "room-state", title: "Movie night", people: 7, cap: 8, open: true, cooling: false, muted: false, placeholder: "Say something…" },
      { t: "room-state", title: null, people: 0, cap: 8, open: false, cooling: true, muted: true, placeholder: "The host muted your chat" },
      { t: "pop-ready", pop: "p1" },
      { t: "pop-ping", pop: "p1" },
      { t: "pop-say", pop: "p1", seq: 1, text: "hello" },
      { t: "pop-emote", pop: "p1", seq: 2, kind: "wave" },
      { t: "pop-back", pop: "p1" },
      { t: "pop-bye", pop: "p1" },
    ];
    for (const m of ok) expect(parsePopMessage(m)).toEqual(m as never);
  });

  test("anything else is dropped: unknown types, extra keys, wrong shapes, oversize text, bad emote kinds", () => {
    const bad: unknown[] = [
      null,
      "room-hello",
      { t: "room-nope" },
      { t: "room-hello", extra: 1 },
      { t: "pop-say", pop: "p1", seq: 1 },
      { t: "pop-say", pop: "p1", seq: -1, text: "x" },
      { t: "pop-say", pop: "p1", seq: 1.5, text: "x" },
      { t: "pop-say", pop: "p1", seq: 1, text: "x".repeat(2000) },
      { t: "pop-say", pop: "", seq: 1, text: "x" },
      { t: "pop-say", pop: "x".repeat(100), seq: 1, text: "x" },
      { t: "pop-emote", pop: "p1", seq: 1, kind: "dance" },
      { t: "room-log", reset: false, entries: [{ kind: "chat", nickname: "Ada", text: "hi" }] },
      { t: "room-log", reset: false, entries: [{ kind: "system", line: { glyph: "boom", actor: null, verb: "x", time: null } }] },
      { t: "room-log", reset: false, entries: Array.from({ length: 500 }, () => ({ kind: "chat", nickname: "a", text: "b", self: false })) },
      { t: "room-state", title: null, people: 1, cap: 8, open: true, cooling: false, muted: false },
    ];
    for (const m of bad) expect(parsePopMessage(m)).toBeNull();
  });
});

// OME-600 (M7 W3b): the whole-room window. The room tab mirrors what the stage draws (the room parsed with the wire's own
// RoomStateSchema), the picture's time for the brass plate, and each emote; the window hands seat clicks back.
const MEMBER = { id: "m1", nickname: "Ada", avatar: 2 };
const ROOM = { id: "movie-night", seats: ["m1", null, null, null, null, null, null, null], members: [MEMBER], embed: null, playback: null };
const VIEW = {
  t: "room-view",
  status: "open",
  self: "m1",
  room: ROOM,
  bubbles: [{ id: 1, memberId: "m1", text: "hi", expiresAt: 1000 }, { id: 2, memberId: "m1", text: "again", expiresAt: 1100 }],
  syslines: [{ glyph: "pause", actor: "Ada", verb: "paused", time: "1:02", id: 4, expiresAt: 2000 }, { glyph: "chat-mute", actor: null, verb: "x", time: null, self: true, id: -1, expiresAt: 3000 }],
  catching: ["m1"],
};

describe("whole-room window messages (OME-600)", () => {
  test("the room view, the plate, emotes, raise, and seat clicks parse; pop-ready may say which window it is", () => {
    const ok: unknown[] = [
      VIEW,
      { ...VIEW, status: "reconnecting", self: null, room: null, bubbles: [], syslines: [], catching: [] },
      // The room left out: unchanged since the last one (review).
      { t: "room-view", status: "open", self: "m1", bubbles: [], syslines: [], catching: [] },
      { t: "room-tv", video: true, playing: true, position: 1531, live: false, catching: false },
      { t: "room-emote", member: "m1", kind: "wave" },
      { t: "room-raise" },
      { t: "pop-sit", pop: "p1", seat: 0 },
      { t: "pop-sit", pop: "p1", seat: 7 },
      { t: "pop-ready", pop: "p1", kind: "room" },
      { t: "pop-ready", pop: "p1", kind: "chat" },
    ];
    for (const m of ok) expect(parsePopMessage(m)).toEqual(m as never);
  });

  test("a room that the wire would refuse is dropped, as are out-of-range seats, too many bubbles and unknown kinds", () => {
    const bad: unknown[] = [
      { ...VIEW, room: { ...ROOM, seats: ["m1"] } },
      { ...VIEW, room: { ...ROOM, seats: ["m9", null, null, null, null, null, null, null] } },
      { ...VIEW, room: { ...ROOM, members: [{ ...MEMBER, nickname: "x".repeat(100) }] } },
      { ...VIEW, status: "lost" },
      { ...VIEW, self: "<script>" },
      { ...VIEW, bubbles: Array.from({ length: 51 }, (_, i) => ({ id: i, memberId: `m${String(i % 25)}`, text: "b", expiresAt: 1 })) },
      { ...VIEW, bubbles: [{ id: 1, memberId: "m1", text: "x".repeat(400), expiresAt: 1 }] },
      { ...VIEW, bubbles: [{ memberId: "m1", text: "no id", expiresAt: 1 }] },
      { ...VIEW, syslines: Array.from({ length: 10 }, (_, i) => ({ glyph: "play", actor: null, verb: "v", time: null, id: i, expiresAt: 1 })) },
      { ...VIEW, extra: true },
      { t: "room-tv", video: true, playing: true, position: -1, live: false, catching: false },
      { t: "room-tv", video: true, playing: true, position: 3 },
      { t: "room-emote", member: "m1", kind: "dance" },
      { t: "pop-sit", pop: "p1", seat: 8 },
      { t: "pop-sit", pop: "p1", seat: -1 },
      { t: "pop-sit", pop: "p1", seat: 1.5 },
      { t: "pop-sit", pop: "p1", seat: null },
      { t: "pop-ready", pop: "p1", kind: "tv" },
    ];
    for (const m of bad) expect(parsePopMessage(m)).toBeNull();
  });

  test("the room window's address is room.html with the same hash", () => {
    expect(roomPopoutUrl("movie-night", "t-abc123")).toBe("/room.html#r=movie-night&t=t-abc123");
    expect(readPopoutHash("#r=movie-night&t=t-abc123")).toEqual({ roomId: "movie-night", tab: "t-abc123" });
  });
});

describe("where the pop-out is offered", () => {
  test("desktop with BroadcastChannel only: never on a phone, never without the channel", () => {
    expect(popoutSupported({ hasChannel: true, phone: false })).toBe(true);
    expect(popoutSupported({ hasChannel: true, phone: true })).toBe(false);
    expect(popoutSupported({ hasChannel: false, phone: false })).toBe(false);
  });
});

describe("the pop-out's address", () => {
  test("carries the room and the tab in the hash, and reads back only valid ones", () => {
    const url = popoutUrl("movie-night", "t-abc123");
    expect(url).toBe("/chat.html#r=movie-night&t=t-abc123");
    expect(readPopoutHash("#r=movie-night&t=t-abc123")).toEqual({ roomId: "movie-night", tab: "t-abc123" });
    expect(readPopoutHash("")).toBeNull();
    expect(readPopoutHash("#r=movie-night")).toBeNull();
    expect(readPopoutHash("#r=Bad Room!&t=t-abc123")).toBeNull();
    expect(readPopoutHash("#r=movie-night&t=<script>")).toBeNull();
  });
});
