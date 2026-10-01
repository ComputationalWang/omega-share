// Rooms of their own for the specs that drive playback or count who is in the room (OME-341). The e2e server boots
// from a DB seeded with these (e2e/fixtures/seed-rooms.ts), so none of them touches the lobby and they run in
// parallel with everything else. One room per test where tests don't build on each other: a fresh room has no
// previous video, and the per-room share bucket (2 at once, then 1 per 10 s) never paces back-to-back cases.
// No imports: the seed script reads this under bun before any server exists.

/** Rooms per spec. A spec that asks for more than its count fails loudly; bump the number here. */
export const SPEC_ROOMS = {
  acceptance: 1,
  sync: 10,
  vimeo: 4,
  "provider-sync": 7,
  "provider-share": 4,
  "provider-generic": 1,
} as const;

export type RoomSpec = keyof typeof SPEC_ROOMS;

export const specRoomIds = (spec: RoomSpec): string[] => Array.from({ length: SPEC_ROOMS[spec] }, (_, i) => `e2e-${spec}-${String(i + 1)}`);

/** Every seeded test room, in seeding order (the lobby is seeded first, so `GET /rooms` still lists it first). */
export const TEST_ROOM_IDS: readonly string[] = (Object.keys(SPEC_ROOMS) as RoomSpec[]).flatMap(specRoomIds);
