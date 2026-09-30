import { describe, expect, test } from "bun:test";
import { MAX_POSITION_S, type PlaybackState, type RoomState } from "@omega/shared";
import { chatIntent, playerIntent, seatViews, seekIntent, sitIntent, togglePlayIntent, type PlaybackTarget } from "../src/intents";
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

const embed = { provider: "youtube", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" } as const;
const playingAt10: PlaybackState = { playing: true, position: 10, rate: 1, at: 1_000_000, rev: 3, action: "play", by: "b" };
const pausedAt10: PlaybackState = { ...playingAt10, playing: false, action: "pause" };
const target = (playback: PlaybackState | null): PlaybackTarget => ({ embed, playback });

describe("togglePlayIntent (shared play/pause key → control)", () => {
  test("paused room: play from where it stopped", () => {
    expect(togglePlayIntent(target(pausedAt10), 1_005_000)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: true, position: 10 });
  });
  test("playing room: pause at the room's position now, from the server clock", () => {
    expect(togglePlayIntent(target(playingAt10), 1_002_500)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: false, position: 12.5 });
  });
  test("no embed or no playback yet: nothing to control", () => {
    expect(togglePlayIntent({ embed: null, playback: null }, 0)).toBeNull();
    expect(togglePlayIntent(target(null), 0)).toBeNull();
    expect(togglePlayIntent({ embed }, 0)).toBeNull();
  });
  test("the position stays within the wire range", () => {
    const far: PlaybackState = { ...playingAt10, position: MAX_POSITION_S - 1 };
    expect(togglePlayIntent(target(far), 1_000_000 + 10_000)).toMatchObject({ position: MAX_POSITION_S });
  });
});

describe("seekIntent (shared seek bar → control)", () => {
  test("keeps the room playing or paused, moves the position", () => {
    expect(seekIntent(target(playingAt10), 750)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: true, position: 750 });
    expect(seekIntent(target(pausedAt10), 3)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: false, position: 3 });
  });
  test("clamps to 0 … MAX_POSITION_S and rejects non-numbers", () => {
    expect(seekIntent(target(playingAt10), -5)).toMatchObject({ position: 0 });
    expect(seekIntent(target(playingAt10), MAX_POSITION_S + 9)).toMatchObject({ position: MAX_POSITION_S });
    expect(seekIntent(target(playingAt10), Number.NaN)).toBeNull();
  });
  test("no playback: null", () => {
    expect(seekIntent(target(null), 5)).toBeNull();
  });
});

describe("playerIntent (a click inside the player → control)", () => {
  test("passes the player's play/pause and position through", () => {
    expect(playerIntent(target(playingAt10), false, 42.5)).toEqual({ type: "control", url: "https://www.youtube.com/embed/dQw4w9WgXcQ", playing: false, position: 42.5 });
  });
  test("no embed: null", () => {
    expect(playerIntent({ embed: null, playback: null }, true, 1)).toBeNull();
  });
});
