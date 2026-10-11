import { expect, test } from "bun:test";
import * as v from "valibot";
import { CreateRoomRequestSchema, DEFAULT_ROOM_PRESET, ROOM_PRESET_IDS } from "../src";

test("room creation accepts only the six judged preset ids and preserves legacy omission", () => {
  const request = { title: "Movie night", visibility: "public" };
  expect(ROOM_PRESET_IDS).toEqual(["classic", "cinema", "living", "lounge", "cafe", "empty"]);
  expect(DEFAULT_ROOM_PRESET).toBe("classic");
  expect(v.parse(CreateRoomRequestSchema, request) as unknown).toEqual(request);
  for (const preset of ["classic", "cinema", "living", "lounge", "cafe", "empty"]) {
    const value = { ...request, preset };
    expect(v.parse(CreateRoomRequestSchema, JSON.parse(JSON.stringify(value))) as unknown).toEqual(value);
  }
  for (const preset of ["unknown", "Classic", "", "../classic", null, {}, 0]) {
    expect(v.safeParse(CreateRoomRequestSchema, { ...request, preset }).success).toBe(false);
  }
  expect(v.safeParse(CreateRoomRequestSchema, { ...request, layout: {} }).success).toBe(false);
});
