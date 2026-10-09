import { expect, test } from "bun:test";
import * as v from "valibot";
import { InviteKeySchema, OwnerTokenSchema, RoomIdSchema } from "@omega/shared";
import { OWNED_ROOMS } from "./owned-rooms";
import { TEST_ROOM_IDS } from "./test-rooms";

test("owned rooms have valid, distinct ids, owner tokens and invite keys, none of them a seeded test room", () => {
  for (const r of OWNED_ROOMS) {
    expect(v.safeParse(RoomIdSchema, r.id).success, r.id).toBe(true);
    expect(r.id).toMatch(/^[a-z2-7]{26}$/);
    expect(v.safeParse(OwnerTokenSchema, r.ownerToken).success, r.name).toBe(true);
    expect(v.safeParse(InviteKeySchema, r.inviteKey).success, r.name).toBe(true);
  }
  const all = OWNED_ROOMS.flatMap((r) => [r.id, r.ownerToken, r.inviteKey]);
  expect(new Set(all).size).toBe(all.length);
  expect(OWNED_ROOMS.map((r) => r.id).filter((id) => TEST_ROOM_IDS.includes(id))).toEqual([]);
});
