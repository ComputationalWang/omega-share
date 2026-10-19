// Outbound corpora (OME-1160): what the server PRODUCES (WebSocket messages, HTTP bodies), so the direction
// is reversed. Two kinds:
//  - `*-roundtrip`: `JSON.stringify` of the TS server's own object literals (key order and optional keys as
//    `apps/server/src/*.ts` write them; the snapshots come from the real `Room`). Rust parses the text and
//    must re-encode it to the identical bytes. The TS side only has to accept it.
//  - `*-raw`: the schema's decision on mutated texts (every key removed, nulled, mistyped; unknown keys;
//    limits), so Rust's `Deserialize` refuses what Valibot refuses and strips what it strips.
// Nothing here holds a lone surrogate, a duplicate key or a `1.0`/`-0` integer, except the entries marked `rustRefuses`.
import * as v from "valibot";
import {
  CreateRoomResponseSchema,
  DeleteRoomResponseSchema,
  QueueAddResponseSchema,
  ReportResponseSchema,
  RoomListResponseSchema,
  ServerMessageSchema,
  ShareResponseSchema,
  normalizeNickname,
  type AnyEmbed,
  type Nickname,
} from "@omega/shared";
import { Room } from "../../server/src/room";
import { decidedRaw, type Case, type Corpus, type RawInput } from "./corpora";

const YT: AnyEmbed = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
const VM: AnyEmbed = { provider: "vimeo", videoId: "76979871", hash: null, url: "https://player.vimeo.com/video/76979871" };
const TW: AnyEmbed = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" };
const GEN: AnyEmbed = { provider: "generic", host: "player.example.com", url: "https://player.example.com/embed/42" };
const AT = 1_790_000_000_000;
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";
const TOKEN2 = "zYxWvUtSrQpOnMlKjIhGfE";
const RESUME = "A".repeat(43);

const nick = (s: string): Nickname => {
  const n = normalizeNickname(s);
  if (n === null) throw new Error(`bad nickname ${s}`);
  return n;
};

/** Real `Room.snapshot()` / `Room.view()` output with the random parts (uuids, clock) made deterministic. */
function snapshotFrames(): string[] {
  const make = (init: ConstructorParameters<typeof Room>[1], setup: (room: Room, ids: string[]) => void): Record<string, unknown> => {
    const room = new Room("film-club", { pinned: false, itemId: "cur1", ...init });
    const ids = ["alice", "Bob 2", "carol", "dave"].map((n, i) => {
      const joined = room.join(nick(n), (i % 4));
      if (!joined.ok) throw new Error("join");
      return joined.member.id;
    });
    setup(room, ids);
    return { snapshot: room.snapshot(), ids, views: room.snapshot().members };
  };
  const frames: string[] = [];
  const emit = (built: Record<string, unknown>, wrap: (self: string, room: unknown) => unknown): void => {
    const ids = built["ids"] as string[];
    let text = JSON.stringify(wrap(ids[0] ?? "", built["snapshot"]));
    const names = new Map<string, string>();
    for (const m of text.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) names.set(m[0], names.get(m[0]) ?? `m${String(names.size + 1)}`);
    for (const [uuid, name] of names) text = text.replaceAll(uuid, name);
    frames.push(text.replace(/"at":\d+/g, `"at":${String(AT)}`));
  };
  const plain = make({ title: "Friday films", embed: YT, queue: [{ id: "q1", embed: VM }, { id: "q2", embed: GEN }] }, (room, ids) => {
    room.sit(ids[0] as never, 2);
    room.sit(ids[1] as never, 5);
    room.setAway(ids[2] as never, true);
    room.setCatching(ids[1] as never, true);
    room.setMuted(ids[2] as never, true);
  });
  emit(plain, (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN }));
  emit(plain, (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN, resumeToken: RESUME, owner: true }));
  emit(plain, (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN, resumeToken: RESUME, resumed: true, owner: true }));
  emit(plain, (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN, resumeToken: RESUME, resumed: true }));
  emit(make({ embed: GEN }, () => undefined), (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN }));
  emit(make({}, () => undefined), (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN2 }));
  emit(make({ embed: TW, title: "Ünïcode" }, (room, ids) => room.sit(ids[3] as never, 7)), (self, room) => ({ type: "snapshot", self, room, shareToken: TOKEN }));
  // Members as `view` builds them: `standingSlot` first, then catching, muted, away.
  const views = (plain["views"] as unknown[]).map((view) => JSON.stringify({ type: "member-joined", member: view }));
  for (const text of views) {
    const names = new Map<string, string>();
    let t = text;
    for (const m of t.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)) names.set(m[0], `m${String(names.size + 1)}`);
    for (const [uuid, name] of names) t = t.replaceAll(uuid, name);
    frames.push(t);
  }
  return frames;
}

const PLAYING = { playing: true, position: 12.5, rate: 1, at: AT, rev: 3, action: "seek", by: "m1" };
const LOAD = { playing: true, position: 0, rate: 1, at: AT, rev: 1, action: "load", by: null };
const PAUSED = { playing: false, position: 3, rate: 0.5, at: AT, rev: 7, action: "pause", by: "m2" };
const ITEM = { id: "q1", embed: YT, by: "m1" };
const MEMBER = { id: "m1", nickname: "alice", avatar: 0, standingSlot: 0 };

const POLL = { pollId: "p1", by: "m1", question: "Next video?", options: ["A", "B", "C"], counts: [0, 2, 1], endsAt: 1_800_000_060_000 };

const FRAMES: unknown[] = [
  { type: "member-joined", member: { ...MEMBER, catching: true, muted: true, away: true } },
  { type: "member-joined", member: { id: "m2", nickname: "Bob 2", avatar: 3, standingSlot: 24, away: true } },
  { type: "member-joined", member: { id: "m3", nickname: "zoë", avatar: 2 } },
  { type: "member-left", memberId: "m1" },
  { type: "member-left", memberId: "m1", reason: "left" },
  { type: "member-left", memberId: "m1", reason: "kicked" },
  { type: "seat-changed", memberId: "m1", seat: 3 },
  { type: "seat-changed", memberId: "m1", seat: 0 },
  { type: "seat-changed", memberId: "m1", seat: 7 },
  { type: "seat-changed", memberId: "m1", seat: null },
  { type: "member-joined", member: { id: "m2", nickname: "Bob 2", avatar: 3, standingSlot: 1, away: true, cell: { x: 4, y: 9 }, tint: 5 } },
  { type: "member-joined", member: { id: "m2", nickname: "Bob 2", avatar: 3, standingSlot: 1, tint: 1 } },
  { type: "walked", memberId: "m1", cell: { x: 0, y: 9 } },
  { type: "walked", memberId: "m1", cell: null },
  ...[0, 3, 5].map((tint) => ({ type: "tint-changed", memberId: "m1", tint })),
  { type: "member-joined", member: { id: "m2", nickname: "Bob 2", avatar: 3, standingSlot: 1, tint: 2, accessory: 4 } },
  ...[0, 2, 4].map((accessory) => ({ type: "accessory-changed", memberId: "m1", accessory })),
  { type: "member-joined", member: { id: "m2", nickname: "Bob 2", avatar: 3, standingSlot: 1, tint: 2, accessory: 4, hair: 5 } },
  ...[0, 3, 5].map((hair) => ({ type: "hair-changed", memberId: "m1", hair })),
  ...[true, false].map((on) => ({ type: "typing-changed", memberId: "m1", on })),
  ...[[2, 1], [2, 2], [6, 4], [100, 1], [100, 100]].map(([sides, value]) => ({ type: "rolled", memberId: "m1", sides, value })),
  { type: "poll", ...POLL }, { type: "poll", ...POLL, options: ["a", "b", "c", "d"], counts: [25, 0, 0, 0] },
  { type: "poll", ...POLL, question: "q".repeat(80), options: ["x".repeat(40), "🎉"], counts: [0, 0], endsAt: 0 },
  { type: "poll-closed", pollId: "p1", counts: [0, 0] }, { type: "poll-closed", pollId: "p_1-X", counts: [1, 2, 3, 4] },
  { type: "chat", memberId: "m1", text: "hello", at: AT },
  { type: "chat", memberId: "m1", text: "emoji 🎉 and <b>tags</b>", at: 0 },
  { type: "embed-changed", embed: YT, by: "m1", playback: LOAD, itemId: "i1" },
  { type: "embed-changed", embed: YT, by: null, playback: LOAD, itemId: "i2" },
  { type: "embed-changed", embed: TW, by: "m1", playback: { ...LOAD, position: 0 }, itemId: "i3" },
  { type: "embed-changed", embed: VM, by: "m1", playback: LOAD, itemId: "i3" },
  { type: "embed-changed", embed: GEN, by: "m1", playback: null, itemId: "i4" },
  { type: "embed-changed", embed: null, by: null, playback: null },
  { type: "queue-changed", queue: [], by: "m1" },
  { type: "queue-changed", queue: [ITEM, { id: "q2", embed: GEN, by: null }], by: null },
  { type: "member-status", memberId: "m1", catching: true },
  { type: "member-status", memberId: "m1", catching: false },
  { type: "member-presence", memberId: "m1", away: true },
  { type: "member-presence", memberId: "m1", away: false },
  { type: "pong", id: 0, at: AT },
  { type: "pong", id: 2 ** 31 - 1, at: AT },
  { type: "playback", playback: PLAYING },
  { type: "playback", playback: LOAD },
  { type: "playback", playback: PAUSED },
  { type: "playback", playback: { ...PLAYING, position: 43200, rate: 2, rev: 0 } },
  { type: "playback", playback: { ...PLAYING, position: 0.1 + 0.2, rate: 0.25 } },
  { type: "playback", playback: { ...PLAYING, position: 1234.5678, rate: 1.5 } },
  { type: "playback", playback: { ...PLAYING, position: 0.00001, rate: 1 } },
  { type: "playback", playback: { ...PLAYING, position: 1e-7, rate: 1 } },
  ...[0.000001, 0.000005, 0.0000099999, 5e-7, 1.5e-7, 5e-324, 43199.99999999996, 43200, 0.1 + 0.7, 1 / 3, 100.1, 12345.678].map((position) => ({ type: "playback", playback: { ...PLAYING, position } })),
  ...[0.25, 0.3, 0.75, 1.25, 1.75].map((rate) => ({ type: "playback", playback: { ...PLAYING, rate } })),
  { type: "playback", playback: { ...PLAYING, position: 86399 / 2, rate: 1 } },
  { type: "layout-changed", layout: { furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }, ...[[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]].map(([col, row]) => ({ kind: "armchair", col, row, facing: (col ?? 0) < (row ?? 0) ? "ne" : "nw" }))] }, by: "m1" },
  { type: "title-changed", title: "Friday films", by: "m1" },
  ...["clap", "exclaim", "heart", "laugh", "question", "wave", "cheer", "yawn", "dance"].map((kind) => ({ type: "emoted", memberId: "m1", kind })),
  { type: "member-muted", memberId: "m2", muted: true },
  { type: "member-muted", memberId: "m2", muted: false },
  { type: "control-policy-changed", policy: "owner", by: "m1" },
  { type: "control-policy-changed", policy: "everyone", by: "m1" },
  { type: "room-full" },
  ...[
    "bad_message", "not_joined", "already_joined", "seat_taken", "rate_limited", "no_embed", "nickname_taken", "too_many_members",
    "invite_required", "not_owner", "muted", "control_owner_only", "bad_target", "queue_full", "unsupported_url", "resume_expired", "bad_cell",
  ].map((code) => ({ type: "error", code, message: `no ${code}` })),
  { type: "error", code: "rate_limited", message: "too many joins, slow down", retryAfterMs: 1500 },
  { type: "error", code: "rate_limited", message: "x", retryAfterMs: 0 },
  { type: "error", code: "rate_limited", message: "x", retryAfterMs: 60_000 },
  { type: "error", code: "bad_message", message: "" },
  { type: "error", code: "bad_message", message: "é".repeat(200) },
  { type: "error", code: "bad_message", message: "😀".repeat(100) },
];

const messageTexts = (): string[] => [...snapshotFrames(), ...FRAMES.map((f) => JSON.stringify(f))];

// ---------------------------------------------------------------- mutations

const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const PLANTS: unknown[] = ["x", -1, 1.5, true, [], {}];

/** Every one-edit variant of `value` down to `depth` levels of objects and arrays. */
function mutations(value: unknown, depth: number): unknown[] {
  const out: unknown[] = [];
  const walk = (node: unknown, path: (string | number)[]): void => {
    const edit = (replace: (parent: Record<string, unknown> | unknown[], key: string | number) => void): void => {
      const copy = clone(value);
      let parent: unknown = copy;
      for (const step of path.slice(0, -1)) parent = (parent as Record<string | number, unknown>)[step];
      const last = path[path.length - 1];
      if (last !== undefined) replace(parent as Record<string, unknown> | unknown[], last);
      out.push(copy);
    };
    if (path.length > 0) {
      edit((p, k) => {
        if (Array.isArray(p)) p.splice(k as number, 1);
        else Reflect.deleteProperty(p, k);
      });
      edit((p, k) => void ((p as Record<string | number, unknown>)[k] = null));
      for (const plant of PLANTS) edit((p, k) => void ((p as Record<string | number, unknown>)[k] = plant));
    }
    if (node !== null && typeof node === "object" && path.length < depth) {
      if (!Array.isArray(node)) {
        const copy = clone(value);
        let parent: unknown = copy;
        for (const step of path) parent = (parent as Record<string | number, unknown>)[step];
        (parent as Record<string, unknown>)["unknownKey"] = 1;
        out.push(copy);
      }
      for (const [k, child] of Object.entries(node)) walk(child, [...path, Array.isArray(node) ? Number(k) : k]);
    }
  };
  walk(value, []);
  return out;
}

const dedup = (xs: readonly string[]): string[] => [...new Set(xs)];
const asInputs = (texts: readonly string[], rustRefuses: readonly string[] = []): RawInput[] => [
  ...dedup(texts).map((text): RawInput => ({ text })),
  ...rustRefuses.map((text): RawInput => ({ text, rustRefuses: true })),
];

// ---------------------------------------------------------------- hand-picked edges

const ROOM = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "lobby",
  seats: [null, null, "m1", null, null, null, null, null],
  members: [{ id: "m1", nickname: "alice", avatar: 0 }, { id: "m2", nickname: "Bob 2", avatar: 3 }],
  embed: YT,
  ...over,
});
const snap = (room: unknown, extra: Record<string, unknown> = {}): string => JSON.stringify({ type: "snapshot", self: "m1", room, ...extra });
const members = (n: number, over: (i: number) => Record<string, unknown> = () => ({})): unknown[] =>
  Array.from({ length: n }, (_, i) => ({ id: `m${String(i)}`, nickname: "alice", avatar: 0, ...over(i) }));
const seatsOf = (...ids: (string | null)[]): (string | null)[] => [...ids, ...Array.from({ length: 8 - ids.length }, () => null)];
const SEAT_LAYOUT = { furniture: [{ kind: "tv", col: 0, row: 0, facing: "se" }, ...[[1, 5], [2, 4], [4, 2], [5, 1], [3, 7], [4, 6], [6, 4], [7, 3]].map(([col, row]) => ({ kind: "armchair", col, row, facing: "ne" }))] };

const EDGE_TEXTS: string[] = [
  // pre-M1b / pre-M4 / pre-M6 servers: optional keys absent
  snap(ROOM()),
  snap(ROOM({ playback: null })),
  snap(ROOM({ playback: LOAD })),
  snap(ROOM({ embed: null })),
  snap(ROOM({ embed: null, playback: LOAD })),
  snap(ROOM({ embed: GEN, playback: LOAD })),
  snap(ROOM({ embed: GEN, playback: null })),
  snap(ROOM({ layout: SEAT_LAYOUT, controlPolicy: "owner", title: "  Ｆｒｉｄａｙ films ", itemId: "i1", queue: [ITEM] })),
  snap(ROOM({ title: "" })),
  snap(ROOM({ title: "x".repeat(32) })),
  snap(ROOM({ title: "x".repeat(33) })),
  snap(ROOM({ title: "a<b" })),
  snap(ROOM({ title: "1\u{FE0F}\u{20E3}" })),
  snap(ROOM({ itemId: "i1" })),
  snap(ROOM({ itemId: "i1", embed: null })),
  snap(ROOM({ itemId: "q1", queue: [ITEM] })),
  snap(ROOM({ itemId: "i1", queue: [] })),
  snap(ROOM({ itemId: "x".repeat(32) })),
  snap(ROOM({ itemId: "x".repeat(33) })),
  snap(ROOM({ queue: Array.from({ length: 20 }, (_, i) => ({ id: `q${String(i)}`, embed: YT, by: null })) })),
  snap(ROOM({ queue: Array.from({ length: 21 }, (_, i) => ({ id: `q${String(i)}`, embed: YT, by: null })) })),
  snap(ROOM({ queue: [ITEM, ITEM] })),
  snap(ROOM({ seats: seatsOf() , members: [] })),
  snap(ROOM({ seats: seatsOf().slice(1) })),
  snap(ROOM({ seats: [...seatsOf(), null] })),
  snap(ROOM({ seats: seatsOf("ghost") })),
  snap(ROOM({ seats: seatsOf("m1", "m1") })),
  snap(ROOM({ seats: seatsOf("m1", "m2") })),
  snap(ROOM({ seats: seatsOf(undefined as never) })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0 }, { id: "m1", nickname: "Bob 2", avatar: 3 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 4 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 1.5 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "", avatar: 0 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "  alice ", avatar: 0 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "ａｌｉｃｅ", avatar: 0 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "x".repeat(20), avatar: 0 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "x".repeat(21), avatar: 0 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, away: "true" }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, catching: false, muted: false, away: false }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, standingSlot: 24 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, standingSlot: 25 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, standingSlot: -1 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, standingSlot: 0 }, { id: "m2", nickname: "Bob 2", avatar: 0, standingSlot: 0 }] })),
  snap(ROOM({ members: [{ id: "m1", nickname: "alice", avatar: 0, standingSlot: 0 }, { id: "m2", nickname: "Bob 2", avatar: 0, standingSlot: 1 }] })),
  snap(ROOM({ seats: seatsOf(), members: members(25, (i) => ({ nickname: `n${String(i)}` })) })),
  snap(ROOM({ seats: seatsOf(), members: members(26, (i) => ({ id: `m${String(i)}` })) })),
  snap(ROOM({ seats: seatsOf(), members: members(25, (i) => ({ standingSlot: i })) })),
  snap(ROOM({ id: "../etc" })),
  snap(ROOM({ id: "a".repeat(32) })),
  snap(ROOM({ id: "a".repeat(33) })),
  snap(ROOM({ id: "" })),
  snap(ROOM({ embed: { ...YT, url: "https://evil.example/" } })),
  snap(ROOM({ layout: { furniture: [] } })),
  snap(ROOM({ layout: { ...SEAT_LAYOUT, extra: 1 } })),
  snap(ROOM({ controlPolicy: "everyone" })),
  snap(ROOM({ controlPolicy: "nobody" })),
  snap(ROOM({ extra: "stripped" })),
  snap(ROOM(), { shareToken: "short" }),
  snap(ROOM(), { shareToken: "A".repeat(23) }),
  snap(ROOM(), { shareToken: TOKEN, resumeToken: "A".repeat(42) }),
  snap(ROOM(), { shareToken: TOKEN, resumeToken: RESUME, resumed: "yes" }),
  snap(ROOM(), { owner: 1 }),
  snap(ROOM(), { resumed: false, owner: false }),
  JSON.stringify({ type: "snapshot", room: ROOM() }),
  JSON.stringify({ type: "snapshot", self: "m1" }),
  JSON.stringify({ type: "snapshot", self: "", room: ROOM() }),
  JSON.stringify({ type: "snapshot", self: "a".repeat(65), room: ROOM() }),
  // embed-changed rules
  JSON.stringify({ type: "embed-changed", embed: YT, by: "m1" }),
  JSON.stringify({ type: "embed-changed", embed: YT }),
  JSON.stringify({ type: "embed-changed", by: null }),
  JSON.stringify({ type: "embed-changed", embed: null, by: null, itemId: "i1" }),
  JSON.stringify({ type: "embed-changed", embed: null, by: null, playback: LOAD }),
  JSON.stringify({ type: "embed-changed", embed: GEN, by: null, playback: LOAD }),
  JSON.stringify({ type: "embed-changed", embed: GEN, by: null, playback: null, itemId: "i1" }),
  JSON.stringify({ type: "embed-changed", embed: { ...YT, url: "javascript:alert(1)" }, by: null }),
  // queue
  JSON.stringify({ type: "queue-changed", queue: [ITEM, ITEM], by: null }),
  JSON.stringify({ type: "queue-changed", queue: [], by: "m1", extra: 1 }),
  JSON.stringify({ type: "queue-changed", queue: [], by: "m1" }),
  JSON.stringify({ type: "queue-changed", queue: [], by: null }),
  JSON.stringify({ type: "queue-changed", queue: [], by: undefined }),
  JSON.stringify({ type: "queue-changed", queue: Array.from({ length: 21 }, (_, i) => ({ id: `q${String(i)}`, embed: YT, by: null })), by: null }),
  JSON.stringify({ type: "queue-changed", queue: [{ id: "q1", embed: YT }], by: null }),
  JSON.stringify({ type: "queue-changed", queue: [{ id: "q1", by: null }], by: null }),
  // numbers
  ...[-1, 0, 2 ** 31 - 1, 2 ** 31, 1.5, "1"].map((id) => JSON.stringify({ type: "pong", id, at: AT })),
  ...[-1, 0, 1.5, "1", null, 2 ** 53].map((at) => JSON.stringify({ type: "pong", id: 1, at })),
  ...[0, 43200, 43200.01, -0.01, 1e-7, "1", null].map((position) => JSON.stringify({ type: "playback", playback: { ...PLAYING, position } })),
  ...[0.25, 0.24, 2, 2.01, 0, 1, "1"].map((rate) => JSON.stringify({ type: "playback", playback: { ...PLAYING, rate } })),
  ...[0, -1, 1.5, "1"].map((rev) => JSON.stringify({ type: "playback", playback: { ...PLAYING, rev } })),
  ...["play", "pause", "seek", "load", "stop", 0, null].map((action) => JSON.stringify({ type: "playback", playback: { ...PLAYING, action } })),
  JSON.stringify({ type: "playback", playback: { ...PLAYING, by: undefined } }),
  JSON.stringify({ type: "playback", playback: { ...PLAYING, extra: 1 } }),
  JSON.stringify({ type: "playback", playback: null }),
  JSON.stringify({ type: "playback" }),
  // error codes and limits
  ...[0, 1, 59_999, 60_000, 60_001, -1, 1.5, "1", null].map((retryAfterMs) => JSON.stringify({ type: "error", code: "rate_limited", message: "m", retryAfterMs })),
  ...[200, 201].flatMap((n) => [JSON.stringify({ type: "error", code: "bad_message", message: "x".repeat(n) }), JSON.stringify({ type: "error", code: "bad_message", message: "😀".repeat(n / 2) }), JSON.stringify({ type: "error", code: "bad_message", message: "😀".repeat(Math.floor(n / 2)) + "é" })]),
  JSON.stringify({ type: "error", code: "oops", message: "" }),
  JSON.stringify({ type: "error", code: 0, message: "" }),
  JSON.stringify({ type: "error", message: "" }),
  JSON.stringify({ type: "error", code: "bad_message" }),
  // chat text rules
  ...["hello", "  hi  ", "x".repeat(280), "x".repeat(281), "", "   ", "a\u0000b", "a‮b", "​", "a​b", "h﻿i", "a b", "‍", "️", "ㅤ", "family \u{1F468}‍\u{1F469}‍\u{1F467} ok", "é́́", "é́́́", "ｆｕｌｌ", "\u{1F600}".repeat(140), "\u{1F600}".repeat(141)].map(
    (text) => JSON.stringify({ type: "chat", memberId: "m1", text, at: AT }),
  ),
  // titles, policies, emotes, reasons
  ...["Friday films", " Ｆｒｉｄａｙ ", "", "x".repeat(33), "a<b", "ok (1)", "1\u{FE0F}\u{20E3}"].map((title) => JSON.stringify({ type: "title-changed", title, by: "m1" })),
  ...["everyone", "owner", "Owner", "nobody", 0, null].map((policy) => JSON.stringify({ type: "control-policy-changed", policy, by: "m1" })),
  ...[{ x: 0, y: 0 }, { x: 9, y: 9 }, { x: 10, y: 0 }, { x: 0, y: -1 }, { x: 1.5, y: 1 }, { x: 1 }, { x: 1, y: 1, z: 1 }, [1, 1], null, undefined].map((cell) => JSON.stringify({ type: "walked", memberId: "m1", cell })),
  ...[0, 5, 6, -1, 0.5, "1", null].map((tint) => JSON.stringify({ type: "tint-changed", memberId: "m1", tint })),
  ...[0, 4, 5, -1, 0.5, "1", null].map((accessory) => JSON.stringify({ type: "accessory-changed", memberId: "m1", accessory })),
  ...[true, false, 1, "true", null, undefined].map((on) => JSON.stringify({ type: "typing-changed", memberId: "m1", on })),
  ...[[6, 0], [6, 7], [6, 6], [1, 1], [101, 1], [6.5, 1], [6, 2.5], [6, -1], ["6", 1], [6, null], [6, undefined]].map(([sides, value]) => JSON.stringify({ type: "rolled", memberId: "m1", sides, value })),
  snap(ROOM(), { poll: POLL }), snap(ROOM(), { owner: true, poll: POLL }), snap(ROOM(), { poll: null }), snap(ROOM(), { poll: { ...POLL, counts: [0] } }),
  ...[[0, 2], [0, 0, 0, 0], [0, -1, 0], [0, 0.5, 0], [0, 26, 0], [0, "1", 0], null].map((counts) => JSON.stringify({ type: "poll", ...POLL, counts })),
  ...[[], ["A"], ["A", "B", "C", "D", "E"], ["A", ""], ["A", "x".repeat(41)], ["A", "\u3164"], null].map((options) => JSON.stringify({ type: "poll", ...POLL, options, counts: options?.map(() => 0) ?? [] })),
  ...["", "q".repeat(81), "a\u202eb", "\u3164", null].map((question) => JSON.stringify({ type: "poll", ...POLL, question })),
  ...[-1, 1.5, "1", null].map((endsAt) => JSON.stringify({ type: "poll", ...POLL, endsAt })),
  ...["", "a b", "a".repeat(33), null].map((pollId) => JSON.stringify({ type: "poll", ...POLL, pollId })), JSON.stringify({ type: "poll", ...POLL, by: "a b" }),
  ...[[1], [0, 0, 0, 0, 0], [0, -1], [0, 26], null].map((counts) => JSON.stringify({ type: "poll-closed", pollId: "p1", counts })), JSON.stringify({ type: "poll-closed", counts: [0, 0] }),
  JSON.stringify({ type: "rolled", memberId: "a b", sides: 6, value: 1 }), JSON.stringify({ type: "rolled", memberId: "m1", sides: 6, value: 1, extra: true }),
  ...[0, 4, 5, null].map((accessory) => JSON.stringify({ type: "member-joined", member: { id: "m1", nickname: "alice", avatar: 0, accessory } })),
  ...[0, 5, 6, -1, 0.5, "1", null].map((hair) => JSON.stringify({ type: "hair-changed", memberId: "m1", hair })),
  ...[0, 5, 6, null].map((hair) => JSON.stringify({ type: "member-joined", member: { id: "m1", nickname: "alice", avatar: 0, hair } })),
  ...[{ x: 1, y: 2 }, { x: 10, y: 0 }, null, { x: 1, y: 2, z: 3 }].map((cell) => JSON.stringify({ type: "member-joined", member: { id: "m1", nickname: "alice", avatar: 0, cell } })),
  ...[0, 5, 6, null].map((tint) => JSON.stringify({ type: "member-joined", member: { id: "m1", nickname: "alice", avatar: 0, tint } })),
  ...["clap", "wave", "cheer", "yawn", "dance", "jump", "Clap", 0, null].map((kind) => JSON.stringify({ type: "emoted", memberId: "m1", kind })),
  ...["left", "kicked", "banned", 0, null].map((reason) => JSON.stringify({ type: "member-left", memberId: "m1", reason })),
  ...[0, 7, 8, -1, 0.5, "1", null, undefined].map((seat) => JSON.stringify({ type: "seat-changed", memberId: "m1", seat })),
  ...["m1", "a".repeat(64), "a".repeat(65), "", "a b", "é", "-_"].map((memberId) => JSON.stringify({ type: "member-muted", memberId, muted: true })),
  // types and tags
  JSON.stringify({ type: "room-full", pad: "x" }),
  JSON.stringify({ type: "ROOM-FULL" }),
  JSON.stringify({ type: "room_full" }),
  JSON.stringify({ type: 0 }),
  JSON.stringify({ type: 17 }),
  JSON.stringify({ type: null }),
  JSON.stringify({ type: ["room-full"] }),
  JSON.stringify({}),
  JSON.stringify({ type: "join", nickname: "alice", avatar: 0 }),
  JSON.stringify({ type: "leave" }),
  JSON.stringify({ type: "chat", memberId: "m1", text: "hi", at: AT, extra: [] }),
  '["room-full"]',
  '["error","bad_message",""]',
  '["pong",1,2]',
  '["chat","m1","hi",1]',
  '["member-joined",{"id":"m1","nickname":"alice","avatar":0}]',
  '{"type":"member-joined","member":["m1","alice",0]}',
  '{"type":"playback","playback":[true,1,1,1,1,"play",null]}',
  '{"type":"queue-changed","queue":[["q1",{"provider":"youtube","videoId":"dQw4w9WgXcQ","url":"https://www.youtube.com/embed/dQw4w9WgXcQ"},null]],"by":null}',
  '{"type":"layout-changed","layout":[],"by":"m1"}',
  "null", "1", '"room-full"', "true", "[]", "{}", "",
  ` {"type":"room-full"} `,
  '{"type":"room-full"} x',
  '{"type":"room-full",}',
];

const RUST_REFUSES: string[] = [
  '{"type":"room-full","type":"room-full"}',
  '{"type":"chat","memberId":"m1","memberId":"m2","text":"hi","at":1}',
  '{"type":"pong","id":1.0,"at":1}',
  '{"type":"pong","id":1,"at":1e3}',
  '{"type":"pong","id":-0,"at":1}',
  '{"type":"pong","id":1,"at":-0}',
  '{"type":"seat-changed","memberId":"m1","seat":1.0}',
  '{"type":"playback","playback":{"playing":true,"position":1,"rate":1,"at":1,"rev":1e0,"action":"play","by":null}}',
];

const rawMessageCases = (): Case[] => {
  const samples = [...messageTexts().slice(0, 12).map((t) => JSON.parse(t) as unknown), ...FRAMES];
  const mutated = samples.filter((s) => JSON.stringify(s).length < 700).flatMap((s) => mutations(s, 2).map((m) => JSON.stringify(m)));
  return decidedRaw(asInputs([...messageTexts(), ...EDGE_TEXTS, ...mutated], RUST_REFUSES), (parsed) => {
    const r = v.safeParse(ServerMessageSchema, parsed);
    return r.success ? r.output : null;
  });
};

const roundtripMessageCases = (): Case[] =>
  messageTexts().map((text) => {
    const r = v.safeParse(ServerMessageSchema, JSON.parse(text));
    if (!r.success) throw new Error(`TS refuses its own frame: ${text}`);
    return { input: text, ok: true, output: text };
  });

// ---------------------------------------------------------------- HTTP responses

const ERR = (code: string, message = "no", retryAfterMs?: number): unknown => ({ ok: false, error: { code, message, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } });
const SHARE_CODES = ["invalid_body", "unsupported_url", "room_not_found", "rate_limited", "payload_too_large", "unauthorized", "control_owner_only", "queue_full"];
const CREATE_CODES = ["invalid_body", "payload_too_large", "rate_limited", "too_many_rooms", "unavailable"];
const DELETE_CODES = ["room_not_found", "unauthorized", "rate_limited", "unavailable"];
const REPORT_CODES = ["invalid_body", "payload_too_large", "room_not_found", "rate_limited", "unavailable"];
const CREATED = (visibility: string): unknown => ({ id: "film-club", title: "Friday films", visibility });

const RESPONSES: Record<string, { schema: v.GenericSchema; samples: unknown[] }> = {
  share: {
    schema: ShareResponseSchema,
    samples: [
      { ok: true, embed: YT }, { ok: true, embed: VM }, { ok: true, embed: TW }, { ok: true, embed: GEN },
      ...SHARE_CODES.map((c) => ERR(c)), ERR("rate_limited", "too many shares, slow down", 1500), ERR("rate_limited", "x", 60_000),
      ERR("invalid_body", "expected { url: string }"),
    ],
  },
  "queue-add": {
    schema: QueueAddResponseSchema,
    samples: [
      { ok: true, item: { id: "q1", embed: YT, by: "m1" } }, { ok: true, item: { id: "q2", embed: GEN, by: null } },
      ...SHARE_CODES.map((c) => ERR(c)), ERR("rate_limited", "too many videos queued, slow down", 3000),
    ],
  },
  "create-room": {
    schema: CreateRoomResponseSchema,
    samples: [
      { ok: true, room: CREATED("public"), ownerToken: TOKEN },
      { ok: true, room: CREATED("private"), ownerToken: TOKEN, inviteKey: TOKEN2 },
      ...CREATE_CODES.map((c) => ERR(c)), ERR("rate_limited", "too many new rooms, try again later", 600_000), ERR("rate_limited", "x", 0),
    ],
  },
  "delete-room": {
    schema: DeleteRoomResponseSchema,
    samples: [{ ok: true }, ...DELETE_CODES.map((c) => ERR(c)), ERR("rate_limited", "too many attempts, slow down", 2000)],
  },
  report: {
    schema: ReportResponseSchema,
    samples: [{ ok: true, status: "received" }, { ok: true, status: "already_reported" }, ...REPORT_CODES.map((c) => ERR(c)), ERR("rate_limited", "too many reports, try again later", 600_000)],
  },
  "room-list": {
    schema: RoomListResponseSchema,
    samples: [
      { rooms: [] },
      { rooms: [{ id: "lobby", memberCount: 3, seatedCount: 2 }, { id: "film-club", memberCount: 25, seatedCount: 8, title: "Friday films" }] },
      { rooms: Array.from({ length: 100 }, (_, i) => ({ id: `r${String(i)}`, memberCount: 0, seatedCount: 0 })) },
    ],
  },
};

/** Hand-picked limits per kind; the generic mutations cover the rest. */
const RESPONSE_EDGES: Record<string, unknown[]> = {
  share: [
    ERR("rate_limited", "x", 60_001), ERR("rate_limited", "x", -1), ERR("rate_limited", "x", 1.5), ERR("rate_limited", "x", null as never),
    ERR("teapot"), ERR("invalid_body", "x".repeat(200)), ERR("invalid_body", "x".repeat(201)), ERR("invalid_body", "😀".repeat(100)), ERR("invalid_body", "😀".repeat(101)),
    { ok: true }, { ok: true, embed: { ...YT, videoId: "x" } }, { embed: YT }, { ok: "true", embed: YT }, { ok: 1, embed: YT }, { ok: null },
    { ok: true, embed: YT, extra: 1 }, { ok: false, error: { code: "invalid_body" } }, { ok: false, error: { message: "" } }, { ok: false }, { ok: false, error: [] },
    { ok: false, error: { code: "invalid_body", message: "", extra: 1 }, extra: 2 }, { ok: true, error: { code: "invalid_body", message: "" } },
    { ok: false, embed: YT }, { ok: true, embed: YT, error: { code: "invalid_body", message: "" } },
  ],
  "queue-add": [{ ok: true }, { ok: true, item: { id: "q1", embed: YT } }, { ok: true, item: { id: "", embed: YT, by: null } }, { ok: true, item: [] }, ERR("rate_limited", "x", 60_001)],
  "create-room": [
    { ok: true, room: CREATED("private"), ownerToken: TOKEN }, { ok: true, room: CREATED("public"), ownerToken: TOKEN, inviteKey: TOKEN2 }, { ok: true, room: CREATED("public") },
    { ok: true, room: CREATED("secret"), ownerToken: TOKEN }, { ok: true, room: { ...(CREATED("public") as object), extra: 1 }, ownerToken: TOKEN },
    { ok: true, room: { id: "film-club", visibility: "public" }, ownerToken: TOKEN }, { ok: true, room: [], ownerToken: TOKEN },
    { ok: true, room: CREATED("public"), ownerToken: "short" }, { ok: true, room: CREATED("private"), ownerToken: TOKEN, inviteKey: null },
    { ok: true, room: { id: "Bad", title: "Friday films", visibility: "public" }, ownerToken: TOKEN },
    ERR("rate_limited", "x", 600_000), ERR("rate_limited", "x", 600_001), ERR("rate_limited", "x", -1), ERR("rate_limited", "x", 1.5),
    ERR("room_not_found"), ERR("too_many_rooms"), ERR("unavailable", "try again"),
  ],
  "delete-room": [{ ok: true, extra: 1 }, { ok: true }, ERR("too_many_rooms"), ERR("rate_limited", "x", 60_000), ERR("rate_limited", "x", 60_001), { ok: [] }],
  report: [{ ok: true, status: "done" }, { ok: true }, ERR("rate_limited", "x", 600_000), ERR("rate_limited", "x", 600_001), ERR("too_many_rooms"), ERR("unavailable", "try again later")],
  "room-list": [
    { rooms: Array.from({ length: 101 }, (_, i) => ({ id: `r${String(i)}`, memberCount: 0, seatedCount: 0 })) },
    { rooms: [{ id: "lobby", memberCount: 1, seatedCount: 2 }] }, { rooms: [{ id: "lobby", memberCount: 2, seatedCount: 2 }] },
    { rooms: [{ id: "lobby", memberCount: 25, seatedCount: 8 }] }, { rooms: [{ id: "lobby", memberCount: 26, seatedCount: 8 }] },
    { rooms: [{ id: "lobby", memberCount: 25, seatedCount: 9 }] }, { rooms: [{ id: "lobby", memberCount: -1, seatedCount: 0 }] },
    { rooms: [{ id: "lobby", memberCount: 1.5, seatedCount: 0 }] }, { rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0, title: null }] },
    { rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0, title: "" }] }, { rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0, title: " Ｆｒｉｄａｙ " }] },
    { rooms: [{ id: "lobby", memberCount: 0, seatedCount: 0, extra: 1 }], extra: 1 }, { rooms: [{ id: "lobby", memberCount: 0 }] }, { rooms: [{ memberCount: 0, seatedCount: 0 }] },
    { rooms: {} }, { rooms: null }, {}, { rooms: [[]] }, { rooms: [["lobby", 0, 0]] }, [], '[[]]',
  ],
};

const RESPONSE_RUST_REFUSES: Record<string, string[]> = {
  share: ['{"ok":true,"ok":true,"embed":null}', '{"ok":false,"error":{"code":"invalid_body","message":"","retryAfterMs":1.0}}'],
  "create-room": ['{"ok":false,"error":{"code":"rate_limited","message":"x","retryAfterMs":1e3}}'],
  "delete-room": ['{"ok":true,"ok":true}'],
  report: ['{"ok":false,"error":{"code":"rate_limited","message":"x","retryAfterMs":-0}}'],
  "queue-add": [],
  "room-list": ['{"rooms":[{"id":"lobby","memberCount":1.0,"seatedCount":0}]}', '{"rooms":[],"rooms":[]}'],
};

type Kind = keyof typeof RESPONSES;
const kinds = Object.keys(RESPONSES);

const rawResponseCases = (): Case[] =>
  kinds.flatMap((kind) => {
    const entry = RESPONSES[kind];
    if (entry === undefined) return [];
    const texts = [...entry.samples, ...(RESPONSE_EDGES[kind] ?? [])].map((s) => (typeof s === "string" ? s : JSON.stringify(s)));
    const mutated = entry.samples.filter((s) => JSON.stringify(s).length < 600).flatMap((s) => mutations(s, 2).map((m) => JSON.stringify(m)));
    const refuses = RESPONSE_RUST_REFUSES[kind] ?? [];
    return decidedRaw(asInputs([...texts, ...mutated, "null", "[]", "{}", ""], refuses), (parsed) => {
      const r = v.safeParse(entry.schema, parsed);
      return r.success ? r.output : null;
    }).map((c) => ({ ...c, input: { kind, text: c.input } }));
  });

const roundtripResponseCases = (): Case[] =>
  kinds.flatMap((kind: Kind) => {
    const entry = RESPONSES[kind];
    return (entry?.samples ?? []).map((sample): Case => {
      const text = JSON.stringify(sample);
      if (!v.safeParse(entry?.schema ?? v.any(), JSON.parse(text)).success) throw new Error(`TS refuses its own body: ${text}`);
      return { input: { kind, text }, ok: true, output: text };
    });
  });

export const outboundCorpora: Corpus[] = [
  { name: "server-message-roundtrip", cases: roundtripMessageCases },
  { name: "server-message-raw", cases: rawMessageCases },
  { name: "response-roundtrip", cases: roundtripResponseCases },
  { name: "response-raw", cases: rawResponseCases },
];
