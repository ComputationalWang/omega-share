// Rooms of their own for the specs that drive playback or count who is in the room (OME-341). The e2e server boots
// from a DB seeded with these (e2e/fixtures/seed-rooms.ts), so none of them touches the lobby and they run in
// parallel with everything else. One room per test where tests don't build on each other: a fresh room has no
// previous video, and the per-room share bucket (2 at once, then 1 per 10 s) never paces back-to-back cases.
// Rooms are named, not handed out in order, so a spec's tests can run on any worker in any order.
// No imports: the seed script reads this under bun before any server exists.

/** Each spec's rooms, by name. A room id is `e2e-<spec>-<name>`, at most ROOM_ID_MAX_LENGTH (32) characters. */
export const SPEC_ROOMS = {
  // First, so it sits in GET /rooms' first MAX_LISTED_ROOMS (seeded rooms list in seed order): reactions.e2e.ts reads its `nowPlaying` (OME-1644).
  listed: ["nowplaying"],
  acceptance: ["main"],
  sync: ["spread", "late", "buffer", "ad", "click", "err150", "volume", "popup"],
  vimeo: ["src", "pause", "privacy", "forged"],
  "provider-sync": ["twvod", "vimeo", "vimeo-rate", "twvod-late", "live", "live-early", "live-forge", "live-ad"],
  "provider-share": ["1", "2", "3", "4"],
  "provider-generic": ["main"],
  "room-view": ["main"],
  walk: ["main", "reduced", "smooth", "free", "keys", "blocked", "over", "follow", "jog", "floor", "conga", "conga-late"],
  reactions: ["bar", "burst"],
  emotes: ["sticker", "waver", "typist", "burst", "still", "wheel", "wheelcost", "wheelwalk", "wheeltap", "slash", "action", "thinker", "dancer", "applause", "palette"],
  polish: ["every", "late", "drop"],
  "provider-queue": ["main", "ended", "generic", "yt", "twvod", "vimeo", "mixed", "reorder", "reorderphone"],
  "queue-perf": ["frames", "spread"],
  "ext-firefox": ["share"],
  "chat-log": ["lines", "keys", "reduced"],
  "chat-perf": ["frames"],
  "phone-layout": ["stack", "touch", "narrow", "drag", "keys", "afterdrag", "pinch", "overscroll", "small", "smallfs", "people390", "people320", "small360"],
  wide: ["w1280", "w1920", "w2560", "people1920", "people2560", "tw1920", "tw2560", "help2560", "phone", "keys", "fs", "scroll", "mo1920", "mo2560", "mophone"],
  "provider-shelf": ["vimeo", "live"],
  "phone-perf": ["frames"],
  "theatre-perf": ["frames"],
  "heap-movie": ["main"],
  fullscreen: ["strip", "band", "keys", "pseudo", "phone", "seatfocus", "pseudotab", "hidechat", "hidepseudo", "portraitkey", "handle", "peek"],
  "provider-fullscreen": ["yt", "twvod", "vimeo", "live", "generic"],
  "fullscreen-perf": ["frames"],
  popout: ["relay", "back", "reopen", "hidden", "gone", "offer", "twice"],
  "popout-perf": ["frames"],
  report: ["send", "states", "gone"],
  "popout-room": ["show", "sit", "back", "fs", "keys", "reduced", "hidden", "chat", "phone", "typing"],
  "popout-room-perf": ["frames"],
  "provider-quality": ["twvod", "live", "fs", "memory", "yt", "generic"],
  "m7-a11y": ["walkseat", "w1280", "w1920", "phone", "fs", "chatwin", "roomwin", "quality", "states", "gone", "log", "logone", "motion", "motionrm", "reduced", "send", "qreduced"],
  "m7-spoof": ["chat", "stage"],
  "wide-perf": ["frames"],
  bubbles: ["renders", "stack", "caps", "fs", "popin", "twin", "typing"],
  "m8-wheel": ["gchat", "gfield", "gdialog", "gime", "gmods", "pick", "close", "outside", "keys", "cool", "walk", "axe", "reduced"],
  "m8-bubbles": ["float", "cap", "reduced", "aria", "abuse", "overlap", "batch"],
  "m8-walk": ["gates", "forced", "latch", "arrival", "abuse"],
  "m9-help": ["hint", "hintesc", "help", "helpkey", "touch", "reduced", "kbkey", "kbq"],
  "m9-hide": ["main", "tag", "popchat", "poproom", "reconn", "typing"],
  "m10-portrait": ["360", "390", "people360", "people390"],
  "landscape-phone": ["l932", "l844", "l667", "q932", "q844", "q667", "notch", "twitch", "tvshelf", "tliveshelf", "vshelf", "vhourshelf", "f844", "f740"],
  "m10-composer": ["l568", "l667", "l932", "p360", "p390"],
  "m10-sessions": ["hide", "reload", "expire", "expreload", "tabs"],
  "m10-a11y": ["dock360", "dock390", "fs", "away", "moved", "fullq"],
  "a11y-sweep": ["w1280", "p390", "l844", "n320"],
  furniture: ["v2seats", "v2benches", "v3poufs", "inuse", "doorstay", "doorgo", "doorgone", "doortarget", "bar", "barstill", "cat"],
  theme: ["desk", "phone", "reduced", "off"],
  targets: ["desk", "touch"],
  "a11y-presence": ["join", "tv"],
  reconnect: ["main"],
  tint: ["pick"],
  hair: ["pick"],
  snap: ["key", "slash"],
  accessory: ["pick", "none", "theme", "bare", "eight"],
  roll: ["two"],
  poll: ["three"],
  hug: ["walk"],
  mention: ["two"],
  outfit: ["wear"],
  "desk-zoom": ["main"],
  teleport: ["pads"],
  doors: ["a", "b"],
  lie: ["sofa"],
  replay: ["wire", "clear", "ui"],
  "reaction-safety": ["shape", "big", "flood", "start"],
} as const;

export type RoomSpec = keyof typeof SPEC_ROOMS;
export type RoomName<S extends RoomSpec> = (typeof SPEC_ROOMS)[S][number];

export const testRoomId = <S extends RoomSpec>(spec: S, name: RoomName<S>): string => `e2e-${spec}-${name}`;

/** Every seeded test room, in seeding order (the lobby is seeded first, so `GET /rooms` still lists it first). */
export const TEST_ROOM_IDS: readonly string[] = (Object.keys(SPEC_ROOMS) as RoomSpec[]).flatMap((spec) =>
  SPEC_ROOMS[spec].map((name: string) => `e2e-${spec}-${name}`),
);
