import { describe, expect, test } from "bun:test";
import type { RoomState } from "@omega/shared";
import { chatIntent, seatViews, sitIntent } from "../src/intents";
import { initialState, reduce, type ViewState } from "../src/state";

const seats = ["b", null, "a", null, null, null, null, null];
const room: RoomState = {
  id: "lobby",
  seats,
  members: [
    { id: "a", nickname: "alice", avatar: 0 },
    { id: "b", nickname: "bob", avatar: 3 },
  ],
  embed: null,
};
const open: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });

describe("sitIntent", () => {
  test("a free seat sends sit", () => {
    expect(sitIntent(open, 1)).toEqual({ type: "sit", seat: 1 });
  });
  test("my own seat stands me up", () => {
    expect(sitIntent(open, 2)).toEqual({ type: "sit", seat: null });
  });
  test("someone else's seat does nothing", () => {
    expect(sitIntent(open, 0)).toBeNull();
  });
  test("nothing is sent while not connected", () => {
    expect(sitIntent(reduce(open, { type: "disconnected" }), 1)).toBeNull();
  });
  test("out-of-range seats do nothing", () => {
    expect(sitIntent(open, 8)).toBeNull();
    expect(sitIntent(open, -1)).toBeNull();
  });
});

describe("chatIntent", () => {
  test("valid text is trimmed into a chat message", () => {
    expect(chatIntent("  hello  ")).toEqual({ type: "chat", text: "hello" });
  });
  test("empty, invisible and oversized text is rejected", () => {
    expect(chatIntent("   ")).toBeNull();
    expect(chatIntent("\u200B")).toBeNull();
    expect(chatIntent("x".repeat(281))).toBeNull();
  });
});

describe("seatViews", () => {
  test("lists all 8 seats with occupant and whether it's me", () => {
    const views = seatViews(open);
    expect(views).toHaveLength(8);
    expect(views[0]).toEqual({ index: 0, member: { id: "b", nickname: "bob", avatar: 3 }, isSelf: false });
    expect(views[1]).toEqual({ index: 1, member: null, isSelf: false });
    expect(views[2]?.isSelf).toBe(true);
  });
  test("with no room, all seats are empty", () => {
    expect(seatViews(initialState).every((v) => v.member === null)).toBe(true);
  });
});
