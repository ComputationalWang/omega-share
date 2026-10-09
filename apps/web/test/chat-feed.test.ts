import { describe, expect, test } from "bun:test";
import type { Member, PlaybackState, RoomState, ServerMessage } from "@omega/shared";
import { initialState, reduce, type ViewEvent, type ViewState } from "../src/state";
import { logEntries } from "../src/chat/feed";

// OME-594: what the chat log says for one view event, from the state before and after it. Chat from members, the
// playback and policy lines the caption rail shows, and the ADR 0030 notices: my mute, someone removed, me removed.

const ada: Member = { id: "a", nickname: "Ada", avatar: 0 };
const kit: Member = { id: "k", nickname: "Kit", avatar: 1 };
const embed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;
const pb = (over: Partial<PlaybackState> = {}): PlaybackState => ({ playing: true, position: 0, rate: 1, at: 1000, rev: 1, action: "load", by: null, ...over });
const room = (over: Partial<RoomState> = {}): RoomState => ({ id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [ada, kit], embed, playback: pb(), ...over });
const joined = (): ViewState => reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room: room() }, now: 0 });

/** Apply `e` to `s` and return what the log gets, plus the next state. */
function step(s: ViewState, e: ViewEvent) {
  const next = reduce(s, e);
  return { entries: logEntries(s, next, e), next };
}
const msg = (m: ServerMessage, now = 0): ViewEvent => ({ type: "server", msg: m, now });

describe("logEntries", () => {
  test("a member's chat is one line with their name; mine is marked", () => {
    expect(step(joined(), msg({ type: "chat", memberId: "k", text: "hi", at: 1 })).entries).toEqual([{ kind: "chat", nickname: "Kit", text: "hi", self: false }]);
    expect(step(joined(), msg({ type: "chat", memberId: "a", text: "me", at: 1 })).entries).toEqual([{ kind: "chat", nickname: "Ada", text: "me", self: true }]);
  });

  test("chat from someone not in the room says nothing (the bubble is dropped too)", () => {
    expect(step(joined(), msg({ type: "chat", memberId: "zz", text: "ghost", at: 1 })).entries).toEqual([]);
  });

  test("a playback change logs the same line as the caption rail", () => {
    const { entries } = step(joined(), msg({ type: "playback", playback: pb({ rev: 2, action: "pause", playing: false, by: "k" }) }));
    expect(entries).toEqual([{ kind: "system", line: { glyph: "pause", actor: "Kit", verb: "paused", time: null } }]);
  });

  test("a stale playback rev logs nothing", () => {
    expect(step(joined(), msg({ type: "playback", playback: pb({ rev: 1, action: "pause" }) })).entries).toEqual([]);
  });

  test("the control policy line is logged", () => {
    const { entries } = step(joined(), msg({ type: "control-policy-changed", policy: "owner", by: "k" }));
    expect(entries).toEqual([{ kind: "system", line: { glyph: "remote", actor: null, verb: "Only the host controls playback now", time: null } }]);
  });

  test("my mute and unmute are logged as only-you lines; someone else's mute isn't", () => {
    const muted = step(joined(), msg({ type: "member-muted", memberId: "a", muted: true }));
    expect(muted.entries).toEqual([{ kind: "system", line: { glyph: "chat-mute", actor: "The host", verb: "muted your chat. You can still watch and emote.", time: null, self: true } }]);
    expect(step(muted.next, msg({ type: "member-muted", memberId: "a", muted: false })).entries).toEqual([
      { kind: "system", line: { glyph: "chat-mute", actor: "The host", verb: "unmuted your chat", time: null, self: true } },
    ]);
    expect(step(joined(), msg({ type: "member-muted", memberId: "k", muted: true })).entries).toEqual([]);
  });

  test("someone removed by the host is logged by name; someone leaving isn't", () => {
    expect(step(joined(), msg({ type: "member-left", memberId: "k", reason: "kicked" })).entries).toEqual([
      { kind: "system", line: { glyph: "host", actor: "Kit", verb: "was removed by the host", time: null } },
    ]);
    expect(step(joined(), msg({ type: "member-left", memberId: "k", reason: "left" })).entries).toEqual([]);
    expect(step(joined(), msg({ type: "member-left", memberId: "k" })).entries).toEqual([]);
  });

  test("being removed myself is an only-you line, said once", () => {
    const first = step(joined(), { type: "kicked", until: 600_000 });
    expect(first.entries).toEqual([{ kind: "system", line: { glyph: "host", actor: "The host", verb: "removed you from the room", time: null, self: true } }]);
    expect(step(first.next, { type: "kicked", until: 600_000 }).entries).toEqual([]);
  });

  test("a snapshot, a tick and a drop log nothing", () => {
    expect(step(initialState, msg({ type: "snapshot", self: "a", room: room() })).entries).toEqual([]);
    expect(step(joined(), { type: "tick", now: 100_000 }).entries).toEqual([]);
    expect(step(joined(), { type: "disconnected" }).entries).toEqual([]);
  });
});
