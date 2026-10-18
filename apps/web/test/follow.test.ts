import { describe, expect, test } from "bun:test";
import type { RoomState } from "@omega/shared";
import { followStep } from "../src/walk/follow";
import { initialState, reduce, type ViewState } from "../src/state";

const room: RoomState = {
  id: "lobby",
  seats: [null, null, null, null, null, null, null, null],
  members: [
    { id: "a", nickname: "alice", avatar: 0 },
    { id: "b", nickname: "bob", avatar: 3 },
    { id: "c", nickname: "cy", avatar: 1 },
  ],
  embed: null,
};
const open: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "a", room }, now: 0 });
const walked = (s: ViewState, id: string, x: number, y: number): ViewState => reduce(s, { type: "server", msg: { type: "walked", memberId: id, cell: { x, y } }, now: 0 });
const sat = (s: ViewState, id: string, seat: number): ViewState => (s.room === null ? s : { ...s, room: { ...s.room, seats: s.room.seats.map((m, i) => (i === seat ? id : m)) } });

// OME-1389: following "b" from "a".
describe("followStep", () => {
  const start = walked(walked(open, "a", 9, 9), "b", 6, 9);

  test("the target's walked: walk over again", () => {
    expect(followStep(start, walked(start, "b", 3, 8), "b")).toBe("walk");
  });

  test("someone else's walk, or my own, changes nothing", () => {
    expect(followStep(start, walked(start, "c", 3, 8), "b")).toBeNull();
    expect(followStep(start, walked(start, "a", 7, 9), "b")).toBeNull();
  });

  test("the target sits: stop", () => {
    expect(followStep(start, sat(start, "b", 2), "b")).toBe("stop");
  });

  test("I sit: stop", () => {
    expect(followStep(start, sat(start, "a", 2), "b")).toBe("stop");
  });

  test("the target leaves: stop", () => {
    const left = reduce(start, { type: "server", msg: { type: "member-left", memberId: "b" }, now: 0 });
    expect(followStep(start, left, "b")).toBe("stop");
  });

  test("the room goes away (disconnected): stop", () => {
    expect(followStep(start, reduce(start, { type: "disconnected" }), "b")).toBe("stop");
  });
});
