// What both servers' stores write into the rollback-interop databases (ADR 0050, OME-1144). The TS builder
// (`dump.ts` `build`) and the Rust one (`tests/store_interop.rs`) read `spec.json`, generated from this.
import { DEFAULT_LAYOUT } from "@omega/shared";

const YOUTUBE = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
const TWITCH_LIVE = { provider: "twitch", kind: "live", channel: "shroud", url: "https://player.twitch.tv/?channel=shroud" };
const TWITCH_VOD = { provider: "twitch", kind: "vod", videoId: "1234567890", url: "https://player.twitch.tv/?video=v1234567890" };
const VIMEO = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
const VIMEO_HASH = { provider: "vimeo", videoId: "76979871", hash: "abcdef1234", url: "https://player.vimeo.com/video/76979871?h=abcdef1234" };
const GENERIC = { provider: "generic", host: "example.com", url: "https://example.com/video/%C3%BC?a=1" };

/** The default room with the plant moved and a variant piece added. */
const CUSTOM_LAYOUT = {
  furniture: [
    ...DEFAULT_LAYOUT.furniture.map((f) => (f.kind === "plant" ? { ...f, col: 9, row: 9 } : f)),
    { kind: "monstera", col: 8, row: 8, facing: "se", variant: 1 },
  ],
};

const hex = (byte: number): string => byte.toString(16).padStart(2, "0").repeat(32);
const rid = (c: string): string => c.repeat(22);

export const spec = {
  rooms: [
    { id: "lobby", title: "Lobby", createdAt: 1_700_000_000_000, layout: DEFAULT_LAYOUT, embed: YOUTUBE, lastActiveAt: 1_700_000_100_000 },
    {
      id: "abcdefghijklmnopqrstuvwxyz",
      title: "Ｆｉｌｍ club",
      createdAt: 1_700_000_000_001,
      layout: CUSTOM_LAYOUT,
      visibility: "private",
      pinned: false,
      ownerHash: hex(1),
      inviteHash: hex(2),
      controlPolicy: "owner",
      embed: TWITCH_LIVE,
      itemId: "cur1",
      queue: [
        { id: "q1", embed: VIMEO_HASH },
        { id: "q2", embed: GENERIC },
        { id: "q3", embed: TWITCH_VOD },
        { id: "q4", embed: YOUTUBE },
      ],
    },
    { id: "advance-room", title: "Advance", createdAt: 1_700_000_000_002, layout: DEFAULT_LAYOUT, queue: [{ id: "n1", embed: VIMEO }, { id: "n2", embed: YOUTUBE }], then: "advance" },
    { id: "start-room", title: "", createdAt: 1_700_000_000_003, layout: DEFAULT_LAYOUT, then: "addAndStart", startItem: { id: "s1", embed: YOUTUBE }, queue: [{ id: "s2", embed: VIMEO }] },
    { id: "untitled", title: "", createdAt: 1_700_000_000_000, layout: DEFAULT_LAYOUT },
    { id: "movie-night", title: "Movie night", createdAt: 1_700_000_000_004, layout: CUSTOM_LAYOUT, unpin: true, lastActiveAt: 0 },
    { id: "doomed", title: "Doomed", createdAt: 1_700_000_000_005, layout: DEFAULT_LAYOUT, queue: [{ id: "d1", embed: YOUTUBE }], deleted: true },
    {
      id: "requeue",
      title: "Requeue",
      createdAt: 1_700_000_000_006,
      layout: DEFAULT_LAYOUT,
      embed: YOUTUBE,
      itemId: "cur",
      queue: [{ id: "a", embed: VIMEO }, { id: "b", embed: TWITCH_VOD }, { id: "c", embed: GENERIC }],
      // The current item is not in the queue (remove says false), so its id is free to queue again; a removal leaves a position gap.
      ops: [
        { op: "removeItem", id: "cur" },
        { op: "addItem", item: { id: "cur", embed: VIMEO } },
        { op: "removeItem", id: "b" },
        { op: "removeItem", id: "b" },
        { op: "addItem", item: { id: "d", embed: YOUTUBE } },
      ],
    },
    {
      id: "mutated",
      title: "Before",
      createdAt: 1_700_000_000_007,
      layout: DEFAULT_LAYOUT,
      embed: YOUTUBE,
      itemId: "m1",
      ops: [
        { op: "setTitle", title: "After" },
        { op: "setLayout", layout: CUSTOM_LAYOUT },
        { op: "setEmbed", embed: VIMEO_HASH, itemId: "m2" },
        { op: "setEmbed", embed: null },
        { op: "setTitle", title: "" },
        { op: "setLastActive", at: 1_700_000_500_000 },
      ],
    },
    // 8 astral letters (16 UTF-16 units) and 8 letters with a combining mark that has no precomposed form (16 units): exactly 32.
    { id: "max-title", title: `${"\u{10400}".repeat(8)}${"q\u0301".repeat(8)}`, createdAt: 1_700_000_000_008, layout: DEFAULT_LAYOUT },
    {
      id: "full-queue",
      title: "Twenty",
      createdAt: 1_700_000_000_009,
      layout: DEFAULT_LAYOUT,
      queue: Array.from({ length: 20 }, (_, i) => ({ id: `i${String(i + 1).padStart(2, "0")}`, embed: i % 3 === 0 ? YOUTUBE : i % 3 === 1 ? VIMEO : TWITCH_VOD })),
    },
  ],
  seatHolds: [
    { roomId: "lobby", nameHash: hex(0xaa), seat: 0 },
    { roomId: "lobby", nameHash: hex(0xab), seat: 2 },
    { roomId: "abcdefghijklmnopqrstuvwxyz", nameHash: hex(0xff), seat: 7 },
    { roomId: "doomed", nameHash: hex(0x10), seat: 3 },
    // Same room and name hash again: INSERT OR REPLACE, the later seat wins.
    { roomId: "lobby", nameHash: hex(0xaa), seat: 5 },
  ],
  reports: [
    { id: rid("a"), roomId: "lobby", reason: "spam", note: null, roomTitle: "Lobby", embedUrl: YOUTUBE.url, createdAt: 1_700_002_000_000 },
    { id: rid("b"), roomId: "abcdefghijklmnopqrstuvwxyz", reason: "hate", note: "slurs in the title: ünï 🎬", roomTitle: "Film club", embedUrl: null, createdAt: 1_700_002_000_001 },
    { id: rid("c"), roomId: "abcdefghijklmnopqrstuvwxyz", reason: "sexual", note: null, roomTitle: null, embedUrl: GENERIC.url, createdAt: 1_700_002_000_002 },
    { id: rid("d"), roomId: "movie-night", reason: "violence", note: "x".repeat(300), roomTitle: "Movie night", embedUrl: null, createdAt: 1_700_002_000_003 },
    { id: rid("e"), roomId: "movie-night", reason: "danger", note: null, roomTitle: null, embedUrl: null, createdAt: 1_700_002_000_003 },
    { id: rid("f"), roomId: "lobby", reason: "other", note: null, roomTitle: "Lobby", embedUrl: null, createdAt: 1_700_002_000_004 },
  ],
  /**
   * Report rows past REPORT_MAX_ROWS: `first` rows, those created before `base + closeBelow` closed, then `then` more
   * (each add trims the oldest closed rows). Ids are `bulk` + 18 digits.
   */
  bulk: { first: 4995, then: 10, base: 1_700_001_000_000, closeBelow: 4990 },
  purgeBefore: 1_700_001_000_010,
  /** Report ids dismissed one by one, then rooms whose open reports are actioned, then takedowns. */
  dismiss: [rid("a")],
  actionRooms: ["abcdefghijklmnopqrstuvwxyz"],
  takedowns: [
    { roomId: "gone-room", at: 1_700_000_300_000 },
    { roomId: "gone-room", at: 1_700_000_300_999 },
    { roomId: "abcdefghijklmnopqrstuvwxyz", at: 1_700_000_300_001 },
  ],
  /** The mixed-history step: applied by one server's stores to the database the other one wrote. */
  mixed: {
    newRooms: [
      {
        id: "mixed-new",
        title: "Mixed",
        createdAt: 1_700_000_000_010,
        layout: CUSTOM_LAYOUT,
        visibility: "private",
        pinned: false,
        ownerHash: hex(3),
        inviteHash: hex(4),
        embed: TWITCH_VOD,
        itemId: "mx",
        queue: [{ id: "mq1", embed: GENERIC }],
      },
    ],
    ops: [
      { room: "lobby", op: "setTitle", title: "Lobby two" },
      { room: "lobby", op: "addItem", item: { id: "l1", embed: VIMEO } },
      { room: "lobby", op: "advance", item: { id: "l1", embed: VIMEO } },
      { room: "abcdefghijklmnopqrstuvwxyz", op: "removeItem", id: "q2" },
      { room: "abcdefghijklmnopqrstuvwxyz", op: "addItem", item: { id: "q5", embed: VIMEO } },
      { room: "movie-night", op: "setControlPolicy", policy: "owner" },
      { room: "movie-night", op: "setLastActive", at: 1_700_000_999_999 },
      { room: "movie-night", op: "setPinned", pinned: true },
      { room: "untitled", op: "setEmbed", embed: YOUTUBE, itemId: "u1" },
    ],
    deleteRooms: ["start-room"],
    holds: [{ roomId: "lobby", nameHash: hex(0xcc), seat: 6 }],
    reports: [{ id: rid("g"), roomId: "lobby", reason: "danger", note: "after the switch", roomTitle: "Lobby two", embedUrl: null, createdAt: 1_700_002_900_000 }],
    dismiss: [rid("f")],
    actionRooms: ["movie-night"],
    takedowns: [{ roomId: "mixed-gone", at: 1_700_000_900_001 }],
    purgeBefore: 1_700_002_000_002,
  },
};

export type Spec = typeof spec;
