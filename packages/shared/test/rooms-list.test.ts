import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import { MAX_LISTED_ROOMS, MAX_ROOM_MEMBERS, RoomListResponseSchema, SEAT_COUNT } from "../src/index";

describe("RoomListResponseSchema (GET /rooms)", () => {
  test("accepts a list of room summaries", () => {
    const body = { rooms: [{ id: "lobby", memberCount: 3, seatedCount: 2 }] };
    expect(v.parse(RoomListResponseSchema, body)).toEqual(body);
  });

  test("accepts an empty list", () => {
    expect(v.is(RoomListResponseSchema, { rooms: [] })).toBe(true);
  });

  test("strips unknown keys so the server can add fields", () => {
    const out = v.parse(RoomListResponseSchema, {
      rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0, name: "Lobby" }],
      next: null,
    });
    expect(out).toEqual({ rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0 }] });
  });

  test("rejects counts outside the room limits", () => {
    const bad = [
      { id: "lobby", memberCount: MAX_ROOM_MEMBERS + 1, seatedCount: 0 },
      { id: "lobby", memberCount: -1, seatedCount: 0 },
      { id: "lobby", memberCount: 1.5, seatedCount: 0 },
      { id: "lobby", memberCount: 10, seatedCount: SEAT_COUNT + 1 },
      { id: "lobby", memberCount: 1, seatedCount: 2 },
    ];
    for (const room of bad) expect(v.is(RoomListResponseSchema, { rooms: [room] })).toBe(false);
  });

  test("rejects an invalid room id", () => {
    expect(v.is(RoomListResponseSchema, { rooms: [{ id: "Lobby!", memberCount: 0, seatedCount: 0 }] })).toBe(false);
  });

  test("accepts up to MAX_LISTED_ROOMS rooms and rejects more", () => {
    const room = (i: number) => ({ id: `room-${String(i)}`, memberCount: 0, seatedCount: 0 });
    const full = Array.from({ length: MAX_LISTED_ROOMS }, (_, i) => room(i));
    expect(v.is(RoomListResponseSchema, { rooms: full })).toBe(true);
    expect(v.is(RoomListResponseSchema, { rooms: [...full, room(MAX_LISTED_ROOMS)] })).toBe(false);
  });
});
