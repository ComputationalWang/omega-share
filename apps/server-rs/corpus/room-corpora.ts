// Room core corpora (OME-1163): the pure `playback.ts` math and the `Room` class, driven by the real TS code.
//  - playback-load / playback-expected / playback-control: tuples of (state, embed, control, now); Rust must
//    produce the same state, bit for bit (the TS expression order is mirrored).
//  - room-script: a scripted sequence of Room operations (hand-written and seeded random) run against the real
//    `Room` with fixed ids and times (`crypto.randomUUID` and `Date.now` are pinned while it runs). The trace
//    holds each operation's result plus the snapshot and summary after it; Rust replays the script and must
//    produce the identical trace. The snapshot's `layout` is dropped (it is the default layout throughout and
//    the outbound corpora already cover its bytes).
import { MAX_POSITION_S, SEAT_COUNT, canonicalizeEmbed, normalizeNickname, type AnyEmbed, type Embed, type PlaybackState } from "@omega/shared";
import { nicknameKey } from "@omega/shared/confusables";
import { applyControl, expectedPosition, loadPlayback, restoredPlayback } from "../../server/src/playback";
import { Room } from "../../server/src/room";
import type { Case, Corpus } from "./corpora";

const T0 = 1_700_000_000_000;
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

const embedOf = (url: string): Embed => {
  const e = canonicalizeEmbed(url);
  if (e === null) throw new Error(`not an embed: ${url}`);
  return e;
};
const YT = embedOf("https://www.youtube.com/embed/dQw4w9WgXcQ");
const YT2 = embedOf("https://www.youtube.com/embed/aaaaaaaaaaa");
const VIMEO = embedOf("https://vimeo.com/76979871");
const VIMEO_H = embedOf("https://vimeo.com/76979871/abcdef0123");
const LIVE = embedOf("https://www.twitch.tv/somechannel");
const VOD = embedOf("https://www.twitch.tv/videos/123456789");
const GENERIC: AnyEmbed = { provider: "generic", host: "player.vidsite.com", url: "https://player.vidsite.com/embed/42" };
const GENERIC2: AnyEmbed = { provider: "generic", host: "cdn.vidsite.com", url: "https://cdn.vidsite.com/watch?v=7" };
const SYNCED: Embed[] = [YT, YT2, VIMEO, VIMEO_H, LIVE, VOD];
const EMBEDS: AnyEmbed[] = [...SYNCED, GENERIC, GENERIC2];

/** A small seeded generator (mulberry32): the corpus is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- playback

const BY = "11111111-1111-4111-8111-111111111111";

function states(): PlaybackState[] {
  const out: PlaybackState[] = [];
  for (const playing of [true, false]) {
    for (const position of [0, 10, 10.5, 42, 43199.5, MAX_POSITION_S]) {
      for (const rate of [0.25, 1, 1.5, 2]) {
        out.push({ playing, position, rate, at: T0, rev: playing ? 0 : 3, action: playing ? "load" : "pause", by: position > 40 ? BY : null });
      }
    }
  }
  out.push({ playing: true, position: 0.1 + 0.2, rate: 1.1, at: T0 + 7, rev: 41, action: "play", by: BY });
  out.push({ playing: true, position: 1234.5678, rate: 0.25, at: T0 - 1, rev: 9, action: "seek", by: null });
  return out;
}

const NOWS = [T0 - 5000, T0, T0 + 1, T0 + 999, T0 + 1000, T0 + 2500, T0 + 10_000, T0 + 60_000, T0 + 3_600_000, T0 + 1e8];

function playbackCases(): { load: Case[]; expected: Case[]; control: Case[] } {
  const load: Case[] = [];
  for (const prevRev of [-1, 0, 1, 7, 1000, 2 ** 31]) {
    for (const by of [null, BY]) {
      for (const now of [0, 1, T0, T0 + 12345]) {
        const input = { prevRev, now, by };
        load.push({ input, ok: true, output: loadPlayback(prevRev, now, by) });
      }
    }
  }
  const restored: Case[] = [0, T0].map((now) => ({ input: { prevRev: null, now, by: null }, ok: true, output: restoredPlayback(now) }));
  const all = states();
  const expected: Case[] = [];
  for (const state of all) for (const now of NOWS) expected.push({ input: { state, now }, ok: true, output: expectedPosition(state, now) });

  const control: Case[] = [];
  const add = (state: PlaybackState | null, embed: Embed | null, c: { url: string; playing: boolean; position: number }, now: number): void => {
    const output = applyControl(state, embed, c, BY, now);
    const input = { state, embed, control: c, by: BY, now };
    control.push(output === null ? { input, ok: false } : { input, ok: true, output });
  };
  const rnd = prng(0x1163);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const POSITIONS = [0, 0.5, 1, 8.9, 9, 10, 10.4, 41.2, 120, 300, 43199, MAX_POSITION_S, MAX_POSITION_S + 50, -3, 1e-9];
  for (let i = 0; i < 800; i++) {
    const state = pick(all);
    const embed = pick(SYNCED);
    const exp = expectedPosition(state, pick(NOWS));
    const now = pick(NOWS);
    // Positions around the extrapolated one: the seek threshold, and on both sides of it.
    const e = expectedPosition(state, now);
    const position = rnd() < 0.5 ? pick(POSITIONS) : pick([e, e + 1, e - 1, e + 1.0000001, e - 1.0000001, e + 0.999999, e - 0.5, exp]);
    const url = rnd() < 0.9 ? embed.url : pick([YT2.url, "", YT.url + "?"]);
    add(rnd() < 0.97 ? state : null, rnd() < 0.97 ? embed : null, { url, playing: rnd() < 0.5, position }, now);
  }
  // Deterministic sweep of the threshold against every embed kind.
  for (const embed of SYNCED) {
    for (const state of all.slice(0, 6)) {
      for (const d of [-1.0000001, -1, -0.9999999, 0, 0.9999999, 1, 1.0000001]) {
        for (const playing of [true, false]) {
          add(state, embed, { url: embed.url, playing, position: expectedPosition(state, T0 + 4000) + d }, T0 + 4000);
        }
      }
    }
  }
  return { load: [...load, ...restored], expected, control };
}

const playback = playbackCases();

// ---- room scripts

type Json = Record<string, unknown>;
type Op = Json & { op: string };
interface Script {
  init: Json;
  ops: Op[];
}

const nick = (s: string) => {
  const n = normalizeNickname(s);
  if (n === null) throw new Error(`bad nickname ${s}`);
  return n;
};
const asJson = (v: unknown): unknown => (v === undefined ? null : JSON.parse(JSON.stringify(v)));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function roomOf(init: Json): Room {
  const owner = init["ownerToken"] as string | undefined;
  const invite = init["inviteKey"] as string | undefined;
  const hash = (s: string): Uint8Array => new Uint8Array(new Bun.CryptoHasher("sha256").update(s).digest());
  return new Room("film-club", {
    ...(init["embed"] !== undefined ? { embed: init["embed"] as AnyEmbed } : {}),
    ...(init["title"] !== undefined ? { title: init["title"] as string } : {}),
    ...(init["visibility"] !== undefined ? { visibility: init["visibility"] as "public" | "private" } : {}),
    ...(init["pinned"] !== undefined ? { pinned: init["pinned"] as boolean } : {}),
    ...(init["createdAt"] !== undefined ? { createdAt: init["createdAt"] as number } : {}),
    ...(owner !== undefined ? { ownerHash: hash(owner) } : {}),
    ...(invite !== undefined ? { inviteHash: hash(invite) } : {}),
    ...(init["lastActiveAt"] !== undefined ? { lastActiveAt: init["lastActiveAt"] as number } : {}),
    ...(init["controlPolicy"] !== undefined ? { controlPolicy: init["controlPolicy"] as "everyone" | "owner" } : {}),
    ...(init["itemId"] !== undefined ? { itemId: init["itemId"] as string } : {}),
    ...(init["queue"] !== undefined ? { queue: init["queue"] as { id: string; embed: AnyEmbed }[] } : {}),
    ...(init["itemSince"] !== undefined ? { itemSince: init["itemSince"] as number } : {}),
  });
}

/** Runs one operation on the real Room; the returned value is what the trace records. */
function apply(room: Room, op: Op): unknown {
  const m = op["m"] as string;
  const now = op["now"] as number;
  switch (op.op) {
    case "join": {
      const r = room.join(nick(op["nick"] as string), op["avatar"] as number, (op["client"] as string | null) ?? null);
      return r.ok ? { ok: true, member: r.member } : { ok: false, reason: r.reason };
    }
    case "leave":
      room.leave(m, now);
      return null;
    case "sit":
      return room.sit(m, op["seat"] as number | null);
    case "setMuted":
      return room.setMuted(m, op["muted"] as boolean);
    case "restoreMute":
      return room.restoreMute(m, now);
    case "isMuted":
      return room.isMuted(m);
    case "coolDown":
      room.coolDown(op["client"] as string, op["until"] as number, now);
      return null;
    case "isCoolingDown":
      return room.isCoolingDown(op["client"] as string, now);
    case "moveClient":
      return room.moveClient(m, (op["client"] as string | null) ?? null);
    case "setAway":
      return room.setAway(m, op["away"] as boolean);
    case "setCatching":
      room.setCatching(m, op["catching"] as boolean);
      return null;
    case "isCatching":
      return room.isCatching(m);
    case "takeCatchingChange":
      return room.takeCatchingChange(m);
    case "heldSeats":
      return room.heldSeats().map((h) => ({ nameHash: hex(h.nameHash), seat: h.seat }));
    case "holdNames": {
      const holds = (op["holds"] as [string, number][]).map(([name, seat]) => ({
        nameHash: new Uint8Array(new Bun.CryptoHasher("sha256").update(nicknameKey(nick(name))).digest()),
        seat,
      }));
      room.holdSeats(holds, op["until"] as number);
      return null;
    }
    case "claimHeldSeat":
      return room.claimHeldSeat(m, now);
    case "setEmbed": {
      const r = room.setEmbed((op["embed"] as AnyEmbed | null) ?? null, (op["by"] as string | null) ?? null, (op["itemId"] as string | null) ?? null, op["since"] as number);
      return { playback: r.playback, uncaught: r.uncaught };
    }
    case "enqueue":
      room.enqueue({ id: op["id"] as string, embed: op["embed"] as AnyEmbed, by: (op["by"] as string | null) ?? null });
      return null;
    case "dequeue":
      return room.dequeue(op["id"] as string);
    case "advance": {
      const r = room.advance(op["since"] as number, (op["by"] as string | null) ?? null);
      return r === null ? null : { item: r.item, embedSwitch: { playback: r.embedSwitch.playback, uncaught: r.embedSwitch.uncaught } };
    }
    case "control":
      return room.control(m, op["control"] as { url: string; playing: boolean; position: number });
    case "setTitle":
      room.setTitle((op["title"] as string | null) ?? "");
      return null;
    case "setControlPolicy":
      room.setControlPolicy(op["policy"] as "everyone" | "owner");
      return null;
    case "isOwner":
      return room.isOwner(op["token"] as string);
    case "isInvited":
      return room.isInvited(op["key"] as string);
    case "view":
      return asJson(room.snapshot().members.find((x) => x.id === m) ?? null);
    case "hasOwner":
      return room.hasOwner;
    case "itemInfo":
      return { itemId: room.itemId, itemSince: room.itemSince === Number.NEGATIVE_INFINITY ? "-inf" : room.itemSince, hasGeneric: room.hasGenericEmbed(), count: room.memberCount };
    default:
      throw new Error(`unknown op ${op.op}`);
  }
}

/** Replays `ops` on a fresh Room, pinning the clock and the id source; the trace is what Rust must reproduce. */
function trace(script: Script): unknown[] {
  const realUuid = crypto.randomUUID;
  const realNow = Date.now;
  try {
    let now = T0;
    Date.now = () => now;
    const room = roomOf(script.init);
    return script.ops.map((op) => {
      now = (op["now"] as number | undefined) ?? now;
      if (op.op === "join") (crypto as { randomUUID: () => string }).randomUUID = () => op["id"] as string;
      const result = apply(room, op);
      const snapshot = asJson(room.snapshot()) as Json;
      delete snapshot["layout"];
      return { result: asJson(result), snapshot, summary: asJson(room.summary()) };
    });
  } finally {
    (crypto as { randomUUID: () => string }).randomUUID = realUuid;
    Date.now = realNow;
  }
}

const scriptCase = (script: Script): Case => ({ input: script, ok: true, output: trace(script) });

// Hand-written scripts: one behaviour each, so a disagreement names itself.
const J = (id: string, name: string, extra: Json = {}): Op => ({ op: "join", id, nick: name, avatar: 0, ...extra });
const hand: Script[] = [
  { init: {}, ops: [J("m1", "alice"), J("m2", "bob", { avatar: 3 }), { op: "leave", m: "m1", now: T0 }, J("m3", "carol"), J("m4", "dave")] },
  {
    init: {},
    ops: [
      J("m1", "Ilya"),
      J("m2", "ILYA"),
      J("m3", "ｉlya"),
      J("m4", "llya"),
      J("m5", "Ilja"),
      J("m6", "ilya", { client: "k1" }),
      { op: "leave", m: "m1", now: T0 },
      J("m7", "ilya"),
    ],
  },
  {
    init: {},
    ops: [
      ...[1, 2, 3, 4, 5, 6, 7].map((i) => J(`m${String(i)}`, `guest ${String(i)}`, { client: "k1" })),
      J("x1", "someone", { client: "k2" }),
      J("x2", "guest 1", { client: "k1" }),
      J("x3", "guest 1", { client: "k2" }),
      { op: "leave", m: "m1", now: T0 },
      J("x4", "again", { client: "k1" }),
      { op: "moveClient", m: "m2", client: "k2" },
      { op: "moveClient", m: "m3", client: "k2" },
      { op: "moveClient", m: "m3", client: null },
      { op: "moveClient", m: "ghost", client: "k2" },
    ],
  },
  {
    init: {},
    ops: [
      ...Array.from({ length: 27 }, (_, i) => J(`m${String(i)}`, `member ${String(i)}`)),
      { op: "leave", m: "m7", now: T0 },
      J("late", "latecomer"),
      { op: "leave", m: "m0", now: T0 },
      { op: "leave", m: "m0", now: T0 },
      J("late2", "latecomer two"),
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice"),
      J("m2", "bob"),
      { op: "sit", m: "m1", seat: 0 },
      { op: "sit", m: "m2", seat: 0 },
      { op: "sit", m: "m1", seat: 5 },
      { op: "sit", m: "m2", seat: 0 },
      { op: "sit", m: "m1", seat: 0 },
      { op: "sit", m: "m1", seat: null },
      { op: "sit", m: "ghost", seat: null },
      { op: "sit", m: "m2", seat: 7 },
      { op: "leave", m: "m2", now: T0 },
      { op: "sit", m: "m1", seat: 7 },
      { op: "heldSeats" },
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice"),
      J("m2", "Ilya"),
      J("m3", "standing"),
      { op: "sit", m: "m2", seat: 6 },
      { op: "sit", m: "m1", seat: 2 },
      { op: "heldSeats" },
      { op: "holdNames", holds: [["alice", 4], ["ILYA", 6], ["nobody", 1]], until: T0 + 30_000, now: T0 },
      J("n1", "carol"),
      { op: "claimHeldSeat", m: "n1", now: T0 + 1 },
      { op: "leave", m: "m1", now: T0 + 2 },
      J("n2", "alice"),
      { op: "claimHeldSeat", m: "n2", now: T0 + 30_000 },
      J("n3", "bob"),
      { op: "claimHeldSeat", m: "n3", now: T0 + 30_000 },
      { op: "claimHeldSeat", m: "n2", now: T0 + 30_000 },
      { op: "claimHeldSeat", m: "ghost", now: T0 + 30_000 },
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice"),
      { op: "holdNames", holds: [["alice", 1]], until: T0 + 100, now: T0 },
      { op: "claimHeldSeat", m: "m1", now: T0 + 101 },
      { op: "holdNames", holds: [["alice", 1]], until: T0 + 100, now: T0 },
      { op: "claimHeldSeat", m: "m1", now: T0 + 101 },
      { op: "claimHeldSeat", m: "m1", now: T0 },
    ],
  },
  {
    init: {},
    ops: [
      J("m0", "squatter"),
      { op: "sit", m: "m0", seat: 1 },
      { op: "holdNames", holds: [["alice", 1], ["alice", 2]], until: T0 + 100, now: T0 },
      J("m1", "alice"),
      { op: "claimHeldSeat", m: "m1", now: T0 },
      { op: "sit", m: "m0", seat: null },
      { op: "claimHeldSeat", m: "m1", now: T0 },
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice", { client: "k" }),
      { op: "setMuted", m: "m1", muted: true },
      { op: "setMuted", m: "m1", muted: true },
      { op: "isMuted", m: "m1" },
      { op: "leave", m: "m1", now: T0 },
      J("m2", "alice", { client: "k" }),
      { op: "restoreMute", m: "m2", now: T0 + 599_999 },
      J("m3", "carol", { client: "other" }),
      { op: "restoreMute", m: "m3", now: T0 },
      J("m4", "dave"),
      { op: "restoreMute", m: "m4", now: T0 },
      J("m5", "erin", { client: "k" }),
      { op: "restoreMute", m: "m5", now: T0 + 600_000 },
      { op: "restoreMute", m: "m5", now: T0 },
      { op: "setMuted", m: "m2", muted: false },
      { op: "setMuted", m: "m2", muted: false },
      { op: "setMuted", m: "ghost", muted: true },
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice", { client: "k" }),
      { op: "setMuted", m: "m1", muted: true },
      { op: "leave", m: "m1", now: T0 },
      J("m2", "bob", { client: "k" }),
      { op: "restoreMute", m: "m2", now: T0 },
      { op: "setMuted", m: "m2", muted: false },
      J("m3", "carol", { client: "k" }),
      { op: "restoreMute", m: "m3", now: T0 },
    ],
  },
  {
    init: {},
    ops: [
      { op: "isCoolingDown", client: "k", now: T0 },
      { op: "coolDown", client: "k", until: T0 + 1000, now: T0 },
      { op: "isCoolingDown", client: "k", now: T0 },
      { op: "isCoolingDown", client: "k", now: T0 + 999 },
      { op: "isCoolingDown", client: "other", now: T0 },
      { op: "isCoolingDown", client: "k", now: T0 + 1000 },
      { op: "isCoolingDown", client: "k", now: T0 },
      { op: "coolDown", client: "old", until: T0 + 10, now: T0 },
      { op: "coolDown", client: "live", until: T0 + 5000, now: T0 },
      { op: "coolDown", client: "new", until: T0 + 9000, now: T0 + 10 },
      { op: "isCoolingDown", client: "old", now: T0 },
      { op: "isCoolingDown", client: "live", now: T0 + 20 },
      { op: "coolDown", client: "live", until: T0 + 20, now: T0 + 15 },
      { op: "isCoolingDown", client: "live", now: T0 + 20 },
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice"),
      { op: "setAway", m: "m1", away: false },
      { op: "setAway", m: "m1", away: true },
      { op: "setAway", m: "m1", away: true },
      { op: "setAway", m: "ghost", away: true },
      { op: "setCatching", m: "m1", catching: true },
      { op: "isCatching", m: "m1" },
      { op: "takeCatchingChange", m: "m1" },
      { op: "takeCatchingChange", m: "m1" },
      { op: "setCatching", m: "m1", catching: false },
      { op: "takeCatchingChange", m: "m1" },
      { op: "setCatching", m: "m1", catching: true },
      { op: "setCatching", m: "m1", catching: false },
      { op: "takeCatchingChange", m: "m1" },
      { op: "setCatching", m: "ghost", catching: true },
      { op: "isCatching", m: "ghost" },
      { op: "takeCatchingChange", m: "ghost" },
      { op: "setMuted", m: "m1", muted: true },
      { op: "setCatching", m: "m1", catching: true },
      { op: "view", m: "m1" },
    ],
  },
  {
    init: {},
    ops: [
      J("m1", "alice"),
      J("m2", "bob"),
      J("m3", "carol"),
      { op: "setEmbed", embed: YT, by: "m1", itemId: "i1", since: 12.5, now: T0 + 5 },
      { op: "itemInfo" },
      { op: "control", m: "m2", control: { url: YT.url, playing: false, position: 40 }, now: T0 + 10_000 },
      { op: "control", m: "m2", control: { url: YT2.url, playing: false, position: 40 }, now: T0 + 10_001 },
      { op: "setEmbed", embed: VIMEO, by: null, itemId: "i2", since: 0, now: T0 + 20_000 },
      { op: "setCatching", m: "m1", catching: true },
      { op: "setCatching", m: "m2", catching: true },
      { op: "setCatching", m: "m3", catching: true },
      { op: "takeCatchingChange", m: "m2" },
      { op: "takeCatchingChange", m: "m1" },
      { op: "setEmbed", embed: GENERIC, by: "m3", itemId: "g1", since: 1, now: T0 + 30_000 },
      { op: "itemInfo" },
      { op: "control", m: "m1", control: { url: GENERIC.url, playing: true, position: 0 }, now: T0 + 30_001 },
      { op: "setEmbed", embed: YT, by: "m1", itemId: "i3", since: 2, now: T0 + 40_000 },
      { op: "setEmbed", embed: null, by: null, itemId: "ignored", since: 3, now: T0 + 50_000 },
      { op: "itemInfo" },
      { op: "setEmbed", embed: LIVE, by: "m1", itemId: "i4", since: 4, now: T0 + 60_000 },
      { op: "control", m: "m1", control: { url: LIVE.url, playing: false, position: 99 }, now: T0 + 70_000 },
      { op: "control", m: "m1", control: { url: LIVE.url, playing: true, position: 0 }, now: T0 + 80_000 },
    ],
  },
  {
    init: { embed: YT, itemId: "cur1", itemSince: 7.5 },
    ops: [{ op: "itemInfo" }, { op: "setEmbed", embed: VIMEO, by: null, itemId: "n1", since: 1, now: T0 + 1 }],
  },
  { init: { embed: GENERIC, itemId: "cur1" }, ops: [{ op: "itemInfo" }, { op: "setEmbed", embed: YT, by: null, itemId: "n1", since: 1, now: T0 + 1 }] },
  { init: { embed: LIVE, itemId: "cur1", createdAt: 5, lastActiveAt: 9 }, ops: [{ op: "itemInfo" }, J("m1", "alice"), { op: "control", m: "m1", control: { url: LIVE.url, playing: true, position: 5 }, now: T0 + 3000 }] },
  {
    init: { embed: YT, itemId: "cur1", queue: [{ id: "cur1", embed: YT }, { id: "q1", embed: VIMEO }, { id: "q2", embed: LIVE }] },
    ops: [{ op: "itemInfo" }, { op: "advance", since: 1, by: null, now: T0 }, { op: "advance", since: 2, by: null, now: T0 + 1 }, { op: "advance", since: 3, by: null, now: T0 + 2 }],
  },
  { init: { queue: [{ id: "q1", embed: VIMEO }] }, ops: [{ op: "itemInfo" }, { op: "advance", since: 1, by: null, now: T0 }, { op: "itemInfo" }] },
  {
    init: { title: "Friday films" },
    ops: [
      J("m1", "alice"),
      { op: "enqueue", id: "q1", embed: YT, by: "m1" },
      { op: "enqueue", id: "q2", embed: GENERIC, by: null },
      { op: "enqueue", id: "q3", embed: LIVE, by: "m1" },
      { op: "dequeue", id: "q2" },
      { op: "dequeue", id: "q2" },
      { op: "dequeue", id: "none" },
      { op: "advance", since: 10, by: "m1", now: T0 + 1 },
      { op: "setCatching", m: "m1", catching: true },
      { op: "takeCatchingChange", m: "m1" },
      { op: "enqueue", id: "q4", embed: GENERIC2, by: null },
      { op: "dequeue", id: "q3" },
      { op: "advance", since: 11, by: null, now: T0 + 2 },
      { op: "itemInfo" },
      { op: "advance", since: 12, by: null, now: T0 + 3 },
      { op: "setTitle", title: null },
      { op: "setTitle", title: "Ünïcode" },
      { op: "setControlPolicy", policy: "owner" },
    ],
  },
  {
    init: { visibility: "private", pinned: false, ownerToken: TOKEN, inviteKey: "zYxWvUtSrQpOnMlKjIhGfE" },
    ops: [
      { op: "isOwner", token: TOKEN },
      { op: "isOwner", token: "zYxWvUtSrQpOnMlKjIhGfE" },
      { op: "isOwner", token: "" },
      { op: "isInvited", key: "zYxWvUtSrQpOnMlKjIhGfE" },
      { op: "isInvited", key: TOKEN },
      { op: "hasOwner" },
    ],
  },
  { init: {}, ops: [{ op: "isOwner", token: "" }, { op: "isOwner", token: TOKEN }, { op: "isInvited", key: TOKEN }, { op: "hasOwner" }] },
];

/**
 * A random script built by running it: each operation is chosen against the live Room (so `sit` only names
 * members, as the relay does) and recorded with the trace line it produced.
 */
function fuzz(seed: number): Case {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
  const NICKS = ["alice", "Alice", "bob", "Bob", "Ilya", "ilya", "llya", "ｂob", "carol", "dave", "erin", "frank", "Zoë", "zoe", "аре", "ape", "gus", "hal", "ivy", "jo"];
  const CLIENTS = ["k1", "k2", "k3", null, null];
  const init: Json = rnd() < 0.3 ? { embed: pick(EMBEDS), itemId: "cur0", queue: [{ id: "cur0", embed: YT }, { id: "r1", embed: pick(EMBEDS) }] } : {};
  const ops: Op[] = [];
  const realUuid = crypto.randomUUID;
  const realNow = Date.now;
  let now = T0;
  let nextId = 1;
  Date.now = () => now;
  const outputs: unknown[] = [];
  try {
    const room = roomOf(init);
    const members = (): string[] => room.snapshot().members.map((m) => m.id);
    const known: string[] = [];
    for (let step = 0; step < 70; step++) {
      now += pick([0, 1, 10, 999, 1000, 30_000, 599_999, 600_000, 600_001]);
      const live = members();
      const who = (): string => (rnd() < 0.1 || live.length === 0 ? pick(["ghost", ...known]) : pick(live));
      const kind = pick([
        "join", "join", "join", "join", "leave", "sit", "sit", "sit", "setMuted", "restoreMute", "coolDown", "isCoolingDown", "moveClient",
        "setAway", "setCatching", "setCatching", "takeCatchingChange", "takeCatchingChange", "setEmbed", "setEmbed", "enqueue", "dequeue", "advance",
        "control", "control", "heldSeats", "holdNames", "claimHeldSeat", "isMuted", "setTitle", "setControlPolicy", "itemInfo",
      ]);
      let op: Op;
      switch (kind) {
        case "join":
          op = J(`m${String(nextId++)}`, pick(NICKS), { avatar: Math.floor(rnd() * 4), client: pick(CLIENTS) });
          known.push(op["id"] as string);
          break;
        case "leave":
          op = { op: "leave", m: who(), now };
          break;
        case "sit": {
          const w = rnd() < 0.15 ? "ghost" : live.length > 0 ? pick(live) : "ghost";
          op = { op: "sit", m: w, seat: w === "ghost" || rnd() < 0.2 ? null : Math.floor(rnd() * SEAT_COUNT) };
          break;
        }
        case "setMuted":
          op = { op: "setMuted", m: who(), muted: rnd() < 0.6 };
          break;
        case "restoreMute":
        case "claimHeldSeat":
          op = { op: kind, m: who(), now };
          break;
        case "coolDown":
          op = { op: "coolDown", client: pick(["k1", "k2", "k3"]), until: now + pick([0, 500, 1000, 600_000]), now };
          break;
        case "isCoolingDown":
          op = { op: "isCoolingDown", client: pick(["k1", "k2", "k3"]), now };
          break;
        case "moveClient":
          op = { op: "moveClient", m: who(), client: pick(CLIENTS) };
          break;
        case "setAway":
          op = { op: "setAway", m: who(), away: rnd() < 0.6 };
          break;
        case "setCatching":
          op = { op: "setCatching", m: who(), catching: rnd() < 0.6 };
          break;
        case "takeCatchingChange":
        case "isMuted":
          op = { op: kind, m: who() };
          break;
        case "setEmbed": {
          const embed = rnd() < 0.15 ? null : pick(EMBEDS);
          op = { op: "setEmbed", embed, by: rnd() < 0.5 && live.length > 0 ? pick(live) : null, itemId: `i${String(nextId++)}`, since: pick([0, 1.5, 100, now % 100_000]), now };
          break;
        }
        case "enqueue":
          op = { op: "enqueue", id: `q${String(nextId++)}`, embed: pick(EMBEDS), by: rnd() < 0.5 && live.length > 0 ? pick(live) : null };
          break;
        case "dequeue": {
          const queued = room.snapshot().queue ?? [];
          op = { op: "dequeue", id: rnd() < 0.2 || queued.length === 0 ? "none" : (pick(queued) as { id: string }).id };
          break;
        }
        case "advance":
          op = { op: "advance", since: pick([0, 2.5, 99]), by: rnd() < 0.4 && live.length > 0 ? pick(live) : null, now };
          break;
        case "control": {
          const embed = room.snapshot().embed;
          const url = embed !== null && rnd() < 0.85 ? embed.url : pick([YT.url, YT2.url, LIVE.url, GENERIC.url]);
          op = { op: "control", m: who(), control: { url, playing: rnd() < 0.5, position: pick([0, 1, 8.9, 10.4, 41, 300, now % 1000, MAX_POSITION_S, MAX_POSITION_S + 1, -2]) }, now };
          break;
        }
        case "holdNames":
          op = { op: "holdNames", holds: [[pick(NICKS), Math.floor(rnd() * SEAT_COUNT)], [pick(NICKS), Math.floor(rnd() * SEAT_COUNT)]], until: now + pick([0, 500, 30_000]), now };
          break;
        case "setTitle":
          op = { op: "setTitle", title: rnd() < 0.3 ? null : pick(["Friday films", "Ünïcode", "x"]) };
          break;
        case "setControlPolicy":
          op = { op: "setControlPolicy", policy: pick(["everyone", "owner"] as const) };
          break;
        default:
          op = { op: kind };
      }
      ops.push(op);
      if (op.op === "join") (crypto as { randomUUID: () => string }).randomUUID = () => op["id"] as string;
      const result = apply(room, op);
      const snapshot = asJson(room.snapshot()) as Json;
      delete snapshot["layout"];
      outputs.push({ result: asJson(result), snapshot, summary: asJson(room.summary()) });
    }
  } finally {
    (crypto as { randomUUID: () => string }).randomUUID = realUuid;
    Date.now = realNow;
  }
  return { input: { init, ops }, ok: true, output: outputs };
}

const fuzzCases = (): Case[] => Array.from({ length: 32 }, (_, i) => fuzz(0x5eed + i * 7919));

export const roomCorpora: Corpus[] = [
  { name: "playback-load", cases: () => playback.load },
  { name: "playback-expected", cases: () => playback.expected },
  { name: "playback-control", cases: () => playback.control },
  { name: "room-script", cases: () => [...hand.map(scriptCase), ...fuzzCases()] },
];
