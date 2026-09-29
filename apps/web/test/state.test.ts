import { describe, expect, test } from "bun:test";
import type { Member, RoomState, ServerMessage } from "@omega/shared";
import { BUBBLE_MS, initialState, nextExpiry, reduce, type ViewState } from "../src/state";

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
    expect(s.room?.embed?.videoId).toBe("dQw4w9WgXcQ");
    s = server(s, { type: "embed-changed", embed: null, by: "a" });
    expect(s.room?.embed).toBeNull();
  });

  test("room-full is terminal: later connection events don't leave it", () => {
    let s = server(reduce(initialState, { type: "connecting" }), { type: "room-full" });
    expect(s.status).toBe("full");
    s = reduce(s, { type: "disconnected" });
    s = reduce(s, { type: "connecting" });
    expect(s.status).toBe("full");
  });

  test("error records the last error code", () => {
    const s = server(joined(), { type: "error", code: "seat_taken", message: "taken" });
    expect(s.lastError).toBe("seat_taken");
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
