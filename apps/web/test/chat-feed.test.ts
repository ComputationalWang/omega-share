import { describe, expect, test } from "bun:test";
import type { Member, PlaybackState, RoomState, ServerMessage } from "@omega/shared";
import { initialState, reduce, type ViewEvent, type ViewState } from "../src/state";
import { logEntries } from "../src/chat/feed";
import type { ChatLogEntry } from "../src/chat/log";

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

  // OME-1426: a roll is a log line anyone can read back, and a bubble over the roller (aria-hidden, like every bubble).
  test("a roll logs \"Kit rolled 17 (d20)\"; mine says You", () => {
    expect(step(joined(), msg({ type: "rolled", memberId: "k", sides: 20, value: 17 })).entries).toEqual([{ kind: "system", line: { glyph: "everyone", actor: "Kit", verb: "rolled 17 (d20)", time: null } }]);
    expect(step(joined(), msg({ type: "rolled", memberId: "a", sides: 6, value: 3 })).entries).toEqual([{ kind: "system", line: { glyph: "everyone", actor: "You", verb: "rolled 3 (d6)", time: null } }]);
  });

  test("a roll puts \"🎲 17 / 20\" in a bubble over the roller", () => {
    const { next } = step(joined(), msg({ type: "rolled", memberId: "k", sides: 20, value: 17 }, 500));
    expect(next.bubbles.map((b) => [b.memberId, b.text])).toEqual([["k", "🎲 17 / 20"]]);
  });

  test("a roll from someone not in the room says nothing and shows nothing", () => {
    const { entries, next } = step(joined(), msg({ type: "rolled", memberId: "zz", sides: 6, value: 6 }));
    expect(entries).toEqual([]);
    expect(next.bubbles).toEqual([]);
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

  test("someone removed by the host, or leaving for good, is logged by name (ADR 0043: once, when a hold ends)", () => {
    expect(step(joined(), msg({ type: "member-left", memberId: "k", reason: "kicked" })).entries).toEqual([
      { kind: "system", line: { glyph: "host", actor: "Kit", verb: "was removed by the host", time: null } },
    ]);
    const left: ChatLogEntry[] = [{ kind: "system", line: { glyph: "everyone", actor: "Kit", verb: "left the room", time: null } }];
    expect(step(joined(), msg({ type: "member-left", memberId: "k", reason: "left" })).entries).toEqual(left);
    expect(step(joined(), msg({ type: "member-left", memberId: "k" })).entries).toEqual(left);
    expect(step(joined(), msg({ type: "member-left", memberId: "zz", reason: "left" })).entries).toEqual([]);
  });

  test("someone new joining is logged by name once (OME-1246); a member already here (a resume) logs nothing", () => {
    const zed: Member = { id: "z", nickname: "Zed", avatar: 2 };
    const first = step(joined(), msg({ type: "member-joined", member: zed }));
    expect(first.entries).toEqual([{ kind: "system", line: { glyph: "everyone", actor: "Zed", verb: "joined the room", time: null } }]);
    expect(step(first.next, msg({ type: "member-joined", member: zed })).entries).toEqual([]);
    expect(step(joined(), msg({ type: "member-joined", member: kit })).entries).toEqual([]);
  });

  test("going away and coming back (presence, a resumed snapshot) logs nothing", () => {
    const away = step(joined(), msg({ type: "member-presence", memberId: "k", away: true }));
    expect(away.entries).toEqual([]);
    expect(step(away.next, msg({ type: "member-presence", memberId: "k", away: false })).entries).toEqual([]);
    expect(step(joined(), msg({ type: "snapshot", self: "a", room: room(), resumed: true })).entries).toEqual([]);
  });

  test("being removed myself is an only-you line, said once", () => {
    const first = step(joined(), { type: "kicked", until: 600_000 });
    expect(first.entries).toEqual([{ kind: "system", line: { glyph: "host", actor: "The host", verb: "removed you from the room", time: null, self: true } }]);
    expect(step(first.next, { type: "kicked", until: 600_000 }).entries).toEqual([]);
  });

  test("the snapshot after a drop says once that missed chat isn't shown, resumed or not (OME-1248)", () => {
    const gap: ChatLogEntry[] = [{ kind: "system", line: { glyph: "everyone", actor: null, verb: "You were disconnected; messages sent meanwhile aren't shown", time: null, self: true } }];
    const dropped = reduce(reduce(joined(), { type: "disconnected" }), { type: "connecting" });
    const back = step(dropped, msg({ type: "snapshot", self: "a", room: room(), resumed: true }));
    expect(back.entries).toEqual(gap);
    expect(step(back.next, msg({ type: "snapshot", self: "a", room: room(), resumed: true })).entries).toEqual([]);
    expect(step(reduce(joined(), { type: "disconnected" }), msg({ type: "snapshot", self: "a", room: room() })).entries).toEqual(gap);
  });

  test("a snapshot, a tick and a drop log nothing", () => {
    expect(step(initialState, msg({ type: "snapshot", self: "a", room: room() })).entries).toEqual([]);
    expect(step(joined(), { type: "tick", now: 100_000 }).entries).toEqual([]);
    expect(step(joined(), { type: "disconnected" }).entries).toEqual([]);
  });
});

// OME-1454: the open poll is view state; its result is one log line when it closes. The server never says which option
// I voted, so my vote is mine to keep (a `voted` event) and ends with the poll or when a new one starts.
describe("polls", () => {
  const open = { type: "poll", pollId: "p1", by: "k", question: "Next video?", options: ["A", "B"], counts: [0, 0], endsAt: 90_000 } as const;
  const polled = (): ViewState => reduce(joined(), msg(open));

  test("a poll message opens it; the next one replaces it whole", () => {
    expect(polled().poll).toEqual({ pollId: "p1", by: "k", question: "Next video?", options: ["A", "B"], counts: [0, 0], endsAt: 90_000 });
    const next = reduce(polled(), msg({ ...open, counts: [1, 0] }));
    expect(next.poll?.counts).toEqual([1, 0]);
  });

  test("the snapshot carries an open poll, and a snapshot without one has none", () => {
    const withPoll = reduce(initialState, msg({ type: "snapshot", self: "a", room: room(), poll: { pollId: "p9", by: "a", question: "Q?", options: ["x", "y"], counts: [1, 0], endsAt: 5 } }));
    expect(withPoll.poll?.pollId).toBe("p9");
    expect(reduce(withPoll, msg({ type: "snapshot", self: "a", room: room() })).poll).toBeNull();
  });

  test("my vote is kept across count changes of the same poll and forgotten for a new one", () => {
    let s = reduce(polled(), { type: "voted", pollId: "p1", option: 1 });
    expect(s.vote).toBe(1);
    s = reduce(s, msg({ ...open, counts: [0, 1] }));
    expect(s.vote).toBe(1);
    s = reduce(s, msg({ ...open, pollId: "p2" }));
    expect(s.vote).toBeNull();
  });

  test("a vote for a poll that is not open changes nothing", () => {
    const s = polled();
    expect(reduce(s, { type: "voted", pollId: "other", option: 0 })).toBe(s);
    expect(reduce(joined(), { type: "voted", pollId: "p1", option: 0 }).vote).toBeNull();
  });

  test("closing removes the poll and my vote, and logs the result with the final counts", () => {
    const voted = reduce(polled(), { type: "voted", pollId: "p1", option: 0 });
    const { entries, next } = step(voted, msg({ type: "poll-closed", pollId: "p1", counts: [3, 1] }));
    expect(next.poll).toBeNull();
    expect(next.vote).toBeNull();
    expect(entries).toEqual([{ kind: "system", line: { glyph: "everyone", actor: null, verb: "Poll: Next video? — A 3 · B 1", time: null } }]);
  });

  test("a close for a poll we don't have logs nothing", () => {
    expect(step(joined(), msg({ type: "poll-closed", pollId: "p1", counts: [3, 1] })).entries).toEqual([]);
    expect(step(polled(), msg({ type: "poll-closed", pollId: "zz", counts: [3, 1] })).entries).toEqual([]);
  });
});
