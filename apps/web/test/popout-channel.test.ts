import { describe, expect, test } from "bun:test";
import { parsePopMessage, popoutSupported, popoutUrl, readPopoutHash } from "../src/popout/channel";

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
