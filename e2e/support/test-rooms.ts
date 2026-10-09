// Rooms of their own for the specs that drive playback or count who is in the room (OME-341). The e2e server boots
// from a DB seeded with these (e2e/fixtures/seed-rooms.ts), so none of them touches the lobby and they run in
// parallel with everything else. One room per test where tests don't build on each other: a fresh room has no
// previous video, and the per-room share bucket (2 at once, then 1 per 10 s) never paces back-to-back cases.
// Rooms are named, not handed out in order, so a spec's tests can run on any worker in any order.
// No imports: the seed script reads this under bun before any server exists.

/** Each spec's rooms, by name. A room id is `e2e-<spec>-<name>`, at most ROOM_ID_MAX_LENGTH (32) characters. */
export const SPEC_ROOMS = {
  acceptance: ["main"],
  sync: ["spread", "late", "buffer", "ad", "click", "err150", "volume", "popup"],
  vimeo: ["src", "pause", "privacy", "forged"],
  "provider-sync": ["twvod", "vimeo", "vimeo-rate", "twvod-late", "live", "live-early", "live-forge", "live-ad"],
  "provider-share": ["1", "2", "3", "4"],
  "provider-generic": ["main"],
  "room-view": ["main"],
  walk: ["main", "reduced"],
  emotes: ["sticker", "waver", "typist", "burst", "still"],
  polish: ["every", "late", "drop"],
  "provider-queue": ["main", "ended", "generic", "yt", "twvod", "vimeo", "mixed"],
  "queue-perf": ["frames", "spread"],
  "ext-firefox": ["share"],
  "chat-log": ["lines", "keys", "reduced"],
  "chat-perf": ["frames"],
  "phone-layout": ["stack", "touch", "narrow", "drag", "keys", "afterdrag"],
  wide: ["w1280", "w1920", "phone", "keys", "fs", "scroll"],
  "provider-shelf": ["vimeo", "live"],
  "phone-perf": ["frames"],
  fullscreen: ["strip", "band", "keys", "pseudo", "phone", "seatfocus", "pseudotab"],
  "provider-fullscreen": ["yt", "twvod", "vimeo", "live", "generic"],
  "fullscreen-perf": ["frames"],
  popout: ["relay", "back", "reopen", "hidden", "gone", "offer", "twice"],
  "popout-perf": ["frames"],
  report: ["send", "states", "gone"],
  "popout-room": ["show", "sit", "back", "fs", "keys", "reduced", "hidden", "chat", "phone"],
  "popout-room-perf": ["frames"],
  "provider-quality": ["twvod", "live", "fs", "memory", "yt", "generic"],
} as const;

export type RoomSpec = keyof typeof SPEC_ROOMS;
export type RoomName<S extends RoomSpec> = (typeof SPEC_ROOMS)[S][number];

export const testRoomId = <S extends RoomSpec>(spec: S, name: RoomName<S>): string => `e2e-${spec}-${name}`;

/** Every seeded test room, in seeding order (the lobby is seeded first, so `GET /rooms` still lists it first). */
export const TEST_ROOM_IDS: readonly string[] = (Object.keys(SPEC_ROOMS) as RoomSpec[]).flatMap((spec) =>
  SPEC_ROOMS[spec].map((name: string) => `e2e-${spec}-${name}`),
);
