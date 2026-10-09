import { describe, expect, test } from "bun:test";
import { DEFAULT_LAYOUT, type Member, type RoomLayout, type RoomState, type ServerMessage } from "@omega/shared";
import type { PlaybackState } from "@omega/shared";
import { BUBBLE_MS, CHAT_COOLDOWN_DEFAULT_MS, MAX_SYSLINES, SYSLINE_MS, catchingUp, controlHeld, controlPolicy, coolingDown, initialState, isMuted, nextExpiry, reduce, screen, type ViewState } from "../src/state";
import { lineText } from "../src/controls/sysline";

const alice: Member = { id: "a", nickname: "alice", avatar: 0 };
const bob: Member = { id: "b", nickname: "bob", avatar: 1 };
const carol: Member = { id: "c", nickname: "carol", avatar: 2 };
const embed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;

function room(overrides: Partial<RoomState> = {}): RoomState {
  return { id: "lobby", seats: [null, null, null, null, null, null, null, null], members: [alice, bob], embed: null, ...overrides };
}

const server = (s: ViewState, msg: ServerMessage, now = 0): ViewState => reduce(s, { type: "server", msg, now });
const joined = (r: RoomState = room()): ViewState => server(initialState, { type: "snapshot", self: "a", room: r });

describe("reduce", () => {
  test("snapshot opens the room with self and the server's room state", () => {
    const s = joined();
    expect(s.status).toBe("open");
    expect(s.self).toBe("a");
    expect(s.room?.members.map((m) => m.nickname)).toEqual(["alice", "bob"]);
  });

  test("connecting and disconnect move the status", () => {
    expect(reduce(initialState, { type: "connecting" }).status).toBe("connecting");
    expect(reduce(joined(), { type: "disconnected" }).status).toBe("reconnecting");
  });

  test("member-joined adds a member once", () => {
    let s = server(joined(), { type: "member-joined", member: carol });
    s = server(s, { type: "member-joined", member: carol });
    expect(s.room?.members.map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  test("member-left removes the member, frees their seat and drops their bubble", () => {
    let s = server(joined(room({ seats: [null, "b", null, null, null, null, null, null] })), {
      type: "chat",
      memberId: "b",
      text: "hi",
      at: 1,
    });
    s = server(s, { type: "member-left", memberId: "b" });
    expect(s.room?.members.map((m) => m.id)).toEqual(["a"]);
    expect(s.room?.seats[1]).toBeNull();
    expect(s.bubbles).toEqual([]);
  });

  test("seat-changed moves a member from their old seat to the new one", () => {
    let s = server(joined(), { type: "seat-changed", memberId: "a", seat: 2 });
    expect(s.room?.seats[2]).toBe("a");
    s = server(s, { type: "seat-changed", memberId: "a", seat: 5 });
    expect(s.room?.seats).toEqual([null, null, null, null, null, "a", null, null]);
    s = server(s, { type: "seat-changed", memberId: "a", seat: null });
    expect(s.room?.seats.every((x) => x === null)).toBe(true);
  });

  test("seat-changed for an unknown member is ignored", () => {
    const before = joined();
    expect(server(before, { type: "seat-changed", memberId: "zzz", seat: 0 })).toBe(before);
  });

  test("chat shows one bubble per member, newest wins, expiring BUBBLE_MS later", () => {
    let s = server(joined(), { type: "chat", memberId: "b", text: "first", at: 1 }, 1000);
    s = server(s, { type: "chat", memberId: "b", text: "second", at: 2 }, 2000);
    expect(s.bubbles).toEqual([{ memberId: "b", text: "second", expiresAt: 2000 + BUBBLE_MS }]);
  });

  test("chat from a non-member is ignored", () => {
    const before = joined();
    expect(server(before, { type: "chat", memberId: "zzz", text: "x", at: 1 })).toBe(before);
  });

  test("tick drops expired bubbles and keeps the same state when nothing expired", () => {
    let s = server(joined(), { type: "chat", memberId: "a", text: "one", at: 1 }, 0);
    s = server(s, { type: "chat", memberId: "b", text: "two", at: 1 }, 1000);
    expect(reduce(s, { type: "tick", now: 10 })).toBe(s);
    const later = reduce(s, { type: "tick", now: BUBBLE_MS });
    expect(later.bubbles.map((b) => b.memberId)).toEqual(["b"]);
  });

  test("nextExpiry is the earliest bubble expiry, or null", () => {
    expect(nextExpiry(joined())).toBeNull();
    let s = server(joined(), { type: "chat", memberId: "b", text: "x", at: 1 }, 500);
    s = server(s, { type: "chat", memberId: "a", text: "y", at: 1 }, 100);
    expect(nextExpiry(s)).toBe(100 + BUBBLE_MS);
  });

  test("embed-changed sets and clears the embed", () => {
    let s = server(joined(), { type: "embed-changed", embed, by: null });
    expect(s.room?.embed?.url).toBe("https://www.youtube.com/embed/dQw4w9WgXcQ");
    s = server(s, { type: "embed-changed", embed: null, by: "a" });
    expect(s.room?.embed).toBeNull();
  });

  test("pong leaves the view state unchanged (the clock lives outside the reducer)", () => {
    const s = joined(room({ embed }));
    expect(server(s, { type: "pong", id: 1, at: 5 })).toBe(s);
  });

  test("room-full is terminal: later connection events don't leave it", () => {
    let s = server(reduce(initialState, { type: "connecting" }), { type: "room-full" });
    expect(s.status).toBe("full");
    s = reduce(s, { type: "disconnected" });
    s = reduce(s, { type: "connecting" });
    expect(s.status).toBe("full");
  });

  test("each error is recorded as a new notice, even when the code repeats", () => {
    const s1 = server(joined(), { type: "error", code: "seat_taken", message: "taken" }, 5);
    const s2 = server(s1, { type: "error", code: "seat_taken", message: "taken" }, 9);
    expect(s1.lastError).toEqual({ code: "seat_taken", at: 5 });
    expect(s2.lastError).not.toBe(s1.lastError);
  });

  test("chat changes bubbles but keeps the room object, so the scene needn't redraw", () => {
    const before = joined();
    const after = server(before, { type: "chat", memberId: "a", text: "x", at: 1 });
    expect(after.room).toBe(before.room);
  });

  test("messages before a snapshot don't invent a room", () => {
    const s = server(initialState, { type: "member-joined", member: carol });
    expect(s.room).toBeNull();
  });

  test("a disconnect clears bubbles but keeps the last room on screen", () => {
    const s = reduce(server(joined(), { type: "chat", memberId: "a", text: "x", at: 1 }), { type: "disconnected" });
    expect(s.bubbles).toEqual([]);
    expect(s.room?.members).toHaveLength(2);
  });
});

describe("screen", () => {
  // The stage wrap has a fixed height, so it must leave the layout flow (not just hide the
  // stage inside it) or it pushes the room-full message below the fold (OME-6 QA).
  test("room-full takes the stage wrap and chat out of the flow and shows the message", () => {
    const s = server(joined(), { type: "room-full" });
    expect(screen(s)).toEqual({ stage: false, chat: false, full: true, refused: null, closed: false, kicked: false });
  });

  test("an open room shows the stage and chat, not the full message", () => {
    expect(screen(joined())).toEqual({ stage: true, chat: true, full: false, refused: null, closed: false, kicked: false });
  });

  test("before the first snapshot nothing is laid out", () => {
    expect(screen(reduce(initialState, { type: "connecting" }))).toEqual({ stage: false, chat: false, full: false, refused: null, closed: false, kicked: false });
  });
});

const pb = (over: Partial<PlaybackState> = {}): PlaybackState => ({ playing: true, position: 0, rate: 1, at: 1000, rev: 1, action: "load", by: null, ...over });

describe("reduce: room playback + system lines", () => {
  test("the snapshot's playback is the room's playback, with no system line (joining isn't news)", () => {
    const s = joined(room({ embed, playback: pb({ rev: 4, action: "play", by: "b" }) }));
    expect(s.room?.playback?.rev).toBe(4);
    expect(s.syslines).toEqual([]);
  });

  test("a playback message replaces the playback and adds a text-only system line", () => {
    const s0 = joined(room({ embed, playback: pb({ rev: 1 }) }));
    const next = pb({ rev: 2, action: "pause", playing: false, position: 12, by: "b" });
    const s = server(s0, { type: "playback", playback: next }, 5000);
    expect(s.room?.playback).toEqual(next);
    expect(s.syslines).toEqual([{ id: 2, glyph: "pause", actor: "bob", verb: "paused", time: null, expiresAt: 5000 + SYSLINE_MS }]);
  });

  test("stale or duplicate revs are dropped", () => {
    const s0 = server(joined(room({ embed, playback: pb({ rev: 1 }) })), { type: "playback", playback: pb({ rev: 5, action: "pause" }) });
    expect(server(s0, { type: "playback", playback: pb({ rev: 5, action: "play" }) })).toBe(s0);
    expect(server(s0, { type: "playback", playback: pb({ rev: 4, action: "seek" }) })).toBe(s0);
  });

  test("playback without an embed is ignored", () => {
    const s0 = joined();
    expect(server(s0, { type: "playback", playback: pb({ rev: 9 }) })).toBe(s0);
  });

  test("embed-changed carries the load playback; from the extension it reads Video shared", () => {
    const s = server(joined(), { type: "embed-changed", embed, by: null, playback: pb({ rev: 7 }) }, 100);
    expect(s.room?.playback?.rev).toBe(7);
    expect(s.syslines.map((l) => [l.actor, l.verb])).toEqual([[null, "Video shared"]]);
  });

  test("embed-changed to nothing clears the playback; a pre-M1b embed-changed (no playback) reads as null", () => {
    let s = server(joined(), { type: "embed-changed", embed, by: null, playback: pb({ rev: 7 }) });
    s = server(s, { type: "embed-changed", embed: null, by: "a", playback: null });
    expect(s.room?.playback ?? null).toBeNull();
    s = server(s, { type: "embed-changed", embed, by: null });
    expect(s.room?.playback ?? null).toBeNull();
  });

  test("at most MAX_SYSLINES lines, newest last; they expire after SYSLINE_MS and count for nextExpiry", () => {
    let s = joined(room({ embed, playback: pb({ rev: 1 }) }));
    for (let rev = 2; rev <= 2 + MAX_SYSLINES; rev++) s = server(s, { type: "playback", playback: pb({ rev, action: "pause", by: "a" }) }, rev * 100);
    expect(s.syslines.map((l) => l.id)).toEqual([3, 4, 5]);
    expect(nextExpiry(s)).toBe(300 + SYSLINE_MS);
    s = reduce(s, { type: "tick", now: 400 + SYSLINE_MS });
    expect(s.syslines.map((l) => l.id)).toEqual([5]);
  });

  test("system lines keep the room's seats/members objects, so the scene needn't redraw", () => {
    const s0 = joined(room({ embed, playback: pb({ rev: 1 }) }));
    const s = server(s0, { type: "playback", playback: pb({ rev: 2, action: "pause" }) });
    expect(s.room?.members).toBe(s0.room?.members);
    expect(s.room?.seats).toBe(s0.room?.seats);
  });
});

describe("refused joins (ADR 0016 §4)", () => {
  const refuse = (s: ViewState, code: "nickname_taken" | "too_many_members"): ViewState =>
    server(s, { type: "error", code, message: "no" });

  for (const code of ["nickname_taken", "too_many_members"] as const) {
    test(`${code} before a snapshot refuses the room and says why`, () => {
      const s = refuse(reduce(initialState, { type: "connecting" }), code);
      expect(s.status).toBe("refused");
      expect(s.refusal).toBe(code);
      expect(s.room).toBeNull();
      expect(screen(s)).toEqual({ stage: false, chat: false, full: false, refused: code, closed: false, kicked: false });
    });
  }

  test("a refusal on a rejoin (the name was taken while we were away) also leaves the room", () => {
    const s = refuse(reduce(joined(), { type: "disconnected" }), "nickname_taken");
    expect(s.status).toBe("refused");
    expect(screen(s).stage).toBe(false);
  });

  test("the connection's own disconnect after a refusal doesn't turn it back into reconnecting", () => {
    const s = reduce(reduce(refuse(initialState, "too_many_members"), { type: "disconnected" }), { type: "connecting" });
    expect(s.status).toBe("refused");
    expect(s.refusal).toBe("too_many_members");
  });

  test("once joined on this connection, a stray refusal is ignored (the connection ignores it too)", () => {
    const s = refuse(joined(), "nickname_taken");
    expect(s.status).toBe("open");
    expect(s.refusal).toBeNull();
    expect(screen(s).stage).toBe(true);
  });

  test("other errors are not refusals", () => {
    const s = server(joined(), { type: "error", code: "seat_taken", message: "no" });
    expect(s.status).toBe("open");
    expect(s.refusal).toBeNull();
    expect(screen(s).refused).toBeNull();
  });
});

describe("chat cooldown after rate_limited", () => {
  const limited = (s: ViewState, now: number, retryAfterMs?: number): ViewState =>
    server(s, { type: "error", code: "rate_limited", message: "slow", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }, now);

  test("honours retryAfterMs: cooling down until then, not after", () => {
    const s = limited(joined(), 1000, 2500);
    expect(s.lastError?.code).toBe("rate_limited");
    expect(coolingDown(s, 1000)).toBe(true);
    expect(coolingDown(s, 3499)).toBe(true);
    expect(coolingDown(s, 3500)).toBe(false);
  });

  test("a pre-M3 rate_limited without a hint cools down for the default", () => {
    const s = limited(joined(), 0);
    expect(CHAT_COOLDOWN_DEFAULT_MS).toBe(1000);
    expect(coolingDown(s, 999)).toBe(true);
    expect(coolingDown(s, 1000)).toBe(false);
  });

  test("a shorter second hint never shortens the cooldown", () => {
    const s = limited(limited(joined(), 0, 5000), 100, 200);
    expect(coolingDown(s, 4000)).toBe(true);
  });

  test("the cooldown end is the next expiry, and the tick at that time ends it", () => {
    const s = limited(joined(), 0, 2000);
    expect(nextExpiry(s)).toBe(2000);
    const later = reduce(s, { type: "tick", now: 2000 });
    expect(later).not.toBe(s);
    expect(coolingDown(later, 2000)).toBe(false);
    expect(nextExpiry(later)).toBeNull();
  });

  test("no cooldown by default", () => {
    expect(coolingDown(joined(), 0)).toBe(false);
    expect(nextExpiry(joined())).toBeNull();
  });
});

describe("other members catching up (ADR 0019)", () => {
  test("a snapshot with a catching member shows them catching; absent means not", () => {
    const s = joined(room({ members: [alice, { ...bob, catching: true }, { ...carol, catching: false }] }));
    expect(catchingUp(s, "b")).toBe(true);
    expect(catchingUp(s, "c")).toBe(false);
    expect(catchingUp(s, "a")).toBe(false);
  });

  test("member-status toggles a member on and off without touching members or seats", () => {
    const before = joined();
    const on = server(before, { type: "member-status", memberId: "b", catching: true });
    expect(catchingUp(on, "b")).toBe(true);
    expect(on.room?.members).toBe(before.room?.members);
    expect(on.room?.seats).toBe(before.room?.seats);
    const off = server(on, { type: "member-status", memberId: "b", catching: false });
    expect(catchingUp(off, "b")).toBe(false);
  });

  test("a repeated member-status changes nothing", () => {
    const on = server(joined(), { type: "member-status", memberId: "b", catching: true });
    expect(server(on, { type: "member-status", memberId: "b", catching: true })).toBe(on);
    const s = joined();
    expect(server(s, { type: "member-status", memberId: "b", catching: false })).toBe(s);
  });

  test("member-status for someone not in the room is ignored", () => {
    const s = joined();
    expect(server(s, { type: "member-status", memberId: "zzz", catching: true })).toBe(s);
  });

  test("a member who joins already catching shows it", () => {
    const s = server(joined(), { type: "member-joined", member: { ...carol, catching: true } });
    expect(catchingUp(s, "c")).toBe(true);
  });

  test("a catching member who leaves is forgotten, even if they come back", () => {
    let s = server(joined(), { type: "member-status", memberId: "b", catching: true });
    s = server(s, { type: "member-left", memberId: "b" });
    expect(catchingUp(s, "b")).toBe(false);
    s = server(s, { type: "member-joined", member: bob });
    expect(catchingUp(s, "b")).toBe(false);
  });

  test("a new snapshot replaces what we knew", () => {
    let s = server(joined(), { type: "member-status", memberId: "b", catching: true });
    s = server(s, { type: "snapshot", self: "a", room: room() });
    expect(catchingUp(s, "b")).toBe(false);
  });
});

describe("created rooms (ADR 0028)", () => {
  test("room-closed is terminal: the room leaves the screen and later connection events don't bring it back", () => {
    let s = reduce(joined(), { type: "room-closed" });
    expect(s.status).toBe("closed");
    expect(screen(s)).toEqual({ stage: false, chat: false, full: false, refused: null, closed: true, kicked: false });
    s = reduce(s, { type: "disconnected" });
    s = reduce(s, { type: "connecting" });
    expect(s.status).toBe("closed");
  });

  test("invite_required before joining is a refusal, like nickname_taken", () => {
    const s = server(reduce(initialState, { type: "connecting" }), { type: "error", code: "invite_required", message: "private" });
    expect(s.status).toBe("refused");
    expect(screen(s).refused).toBe("invite_required");
  });
});

describe("owner edits arrive live (OME-410)", () => {
  const moved: RoomLayout = { furniture: DEFAULT_LAYOUT.furniture.map((f) => (f.kind === "lamp" ? { ...f, col: 8 } : f)) };

  test("the snapshot says whether I joined as the owner; a rejoin without it makes me a guest", () => {
    const owner = server(initialState, { type: "snapshot", self: "a", room: room(), owner: true });
    expect(owner.owner).toBe(true);
    expect(joined().owner).toBe(false);
    expect(server(owner, { type: "snapshot", self: "a", room: room() }).owner).toBe(false);
  });

  test("layout-changed replaces the room's layout and keeps its seats and members objects", () => {
    const before = joined(room({ layout: DEFAULT_LAYOUT }));
    const s = server(before, { type: "layout-changed", layout: moved, by: "b" });
    expect(s.room?.layout).toEqual(moved);
    expect(s.room?.seats).toBe(before.room?.seats);
    expect(s.room?.members).toBe(before.room?.members);
  });

  test("layout-changed before a snapshot doesn't invent a room", () => {
    expect(server(initialState, { type: "layout-changed", layout: moved, by: "b" }).room).toBeNull();
  });

  test("title-changed shows the new title; it outlives a rejoin and goes with the room", () => {
    expect(joined().title).toBeNull();
    const s = server(joined(), { type: "title-changed", title: "Friday films", by: "b" });
    expect(s.title).toBe("Friday films");
    expect(server(s, { type: "snapshot", self: "a", room: room() }).title).toBe("Friday films");
    expect(reduce(s, { type: "room-closed" }).title).toBeNull();
  });

  test("the snapshot seeds the title; a later title-changed or titled snapshot replaces it", () => {
    const s = joined(room({ title: "Friday films" }));
    expect(s.title).toBe("Friday films");
    expect(server(s, { type: "title-changed", title: "Sunday films", by: "b" }).title).toBe("Sunday films");
    expect(server(s, { type: "snapshot", self: "a", room: room({ title: "Late films" }) }).title).toBe("Late films");
  });
});

describe("owner moderation (ADR 0030, OME-507)", () => {
  const owned = (r: RoomState = room(), owner = false): ViewState => server(initialState, { type: "snapshot", self: "a", room: r, owner });

  test("the snapshot's muted members and control policy are read; absent fields mean nobody muted and everyone controls", () => {
    expect(controlPolicy(joined())).toBe("everyone");
    expect(isMuted(joined(), "b")).toBe(false);
    const s = joined(room({ members: [alice, { ...bob, muted: true }], controlPolicy: "owner" }));
    expect(controlPolicy(s)).toBe("owner");
    expect(isMuted(s, "b")).toBe(true);
    expect(isMuted(s, "a")).toBe(false);
  });

  test("member-muted toggles a member's mute without touching the members array (no scene redraw)", () => {
    const before = joined();
    let s = server(before, { type: "member-muted", memberId: "b", muted: true });
    expect(isMuted(s, "b")).toBe(true);
    expect(s.room?.members).toBe(before.room?.members);
    s = server(s, { type: "member-muted", memberId: "b", muted: false });
    expect(isMuted(s, "b")).toBe(false);
  });

  test("member-muted for someone not in the room is ignored", () => {
    const before = joined();
    expect(server(before, { type: "member-muted", memberId: "zz", muted: true })).toBe(before);
  });

  test("a member who joins muted (the server remembered their address) shows muted; leaving forgets it", () => {
    let s = server(joined(), { type: "member-joined", member: { ...carol, muted: true } });
    expect(isMuted(s, "c")).toBe(true);
    s = server(s, { type: "member-left", memberId: "c", reason: "kicked" });
    expect(isMuted(s, "c")).toBe(false);
    expect(s.room?.members.map((m) => m.id)).toEqual(["a", "b"]);
  });

  test("being muted myself says so once in the log, as an only-you line; unmuting says that too", () => {
    let s = server(joined(), { type: "member-muted", memberId: "a", muted: true }, 100);
    expect(isMuted(s, "a")).toBe(true);
    expect(s.syslines.at(-1)?.self).toBe(true);
    expect(s.syslines.at(-1)?.glyph).toBe("chat-mute");
    expect(s.syslines.map(lineText).at(-1)).toBe("The host muted your chat. You can still watch and emote.");
    s = server(s, { type: "member-muted", memberId: "a", muted: false }, 200);
    expect(s.syslines.map(lineText).at(-1)).toBe("The host unmuted your chat");
  });

  test("someone else's mute isn't announced to the room", () => {
    const s = server(joined(), { type: "member-muted", memberId: "b", muted: true });
    expect(s.syslines).toEqual([]);
  });

  test("control-policy-changed updates the policy and tells the room in the log", () => {
    let s = server(joined(), { type: "control-policy-changed", policy: "owner", by: "b" }, 10);
    expect(controlPolicy(s)).toBe("owner");
    expect(s.syslines.map(lineText)).toEqual(["Only the host controls playback now"]);
    expect(s.syslines[0]?.glyph).toBe("remote");
    s = server(s, { type: "control-policy-changed", policy: "everyone", by: "b" }, 20);
    expect(controlPolicy(s)).toBe("everyone");
    expect(s.syslines.map(lineText)).toEqual(["Only the host controls playback now", "bob gave the remote to everyone"]);
    // Ids stay unique next to playback lines (keyed by rev) so the rail never drops one.
    expect(new Set(s.syslines.map((l) => l.id)).size).toBe(2);
  });

  test("controls are held for a guest under policy owner, never for the owner and never under everyone", () => {
    const guest = owned(room({ controlPolicy: "owner" }), false);
    expect(controlHeld(guest)).toBe(true);
    expect(controlHeld(owned(room({ controlPolicy: "owner" }), true))).toBe(false);
    expect(controlHeld(owned(room({ controlPolicy: "everyone" }), false))).toBe(false);
    expect(controlHeld(initialState)).toBe(false);
  });

  test("kicked is terminal with the time the cooldown ends; the room leaves the screen and stays gone", () => {
    let s = reduce(joined(), { type: "kicked", until: 600_000 });
    expect(s.status).toBe("kicked");
    expect(s.kickedUntil).toBe(600_000);
    expect(screen(s)).toEqual({ stage: false, chat: false, full: false, refused: null, closed: false, kicked: true });
    s = reduce(s, { type: "disconnected" });
    s = reduce(s, { type: "connecting" });
    expect(s.status).toBe("kicked");
  });

  test("kicked with an unknown cooldown end (a bounce from another tab) keeps null", () => {
    const s = reduce(joined(), { type: "kicked", until: null });
    expect(s.status).toBe("kicked");
    expect(s.kickedUntil).toBeNull();
  });
});
