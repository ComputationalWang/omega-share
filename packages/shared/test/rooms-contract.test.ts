import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  CLOSE_CODES,
  CreateRoomRequestSchema,
  CreateRoomResponseSchema,
  DEFAULT_LAYOUT,
  DeleteRoomResponseSchema,
  FURNITURE,
  FURNITURE_KINDS,
  InviteKeySchema,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_CREATE_BODY_BYTES,
  MAX_FURNITURE,
  MAX_ROOMS,
  MAX_ROOM_SECRETS,
  OwnerTokenSchema,
  ROOM_CREATE_GLOBAL_BURST,
  ROOM_CREATE_GLOBAL_REFILL_MS,
  ROOM_CREATE_KEY_BURST,
  ROOM_CREATE_KEY_REFILL_MS,
  ROOM_CREATE_RETRY_AFTER_MAX_MS,
  RETRY_AFTER_MAX_MS,
  ServerMessageSchema,
  ShareResponseSchema,
  ROOM_EDIT_BURST,
  ROOM_EDIT_REFILL_MS,
  ROOM_GC_EMPTY_MS,
  ROOM_GC_NEVER_JOINED_MS,
  ROOM_GC_SWEEP_MS,
  ROOM_SECRETS_STORAGE_KEY,
  ROOM_TITLE_MAX_LENGTH,
  RoomLayoutInputSchema,
  RoomLayoutSchema,
  RoomSecretsSchema,
  RoomSummarySchema,
  RoomTitleSchema,
  SHARE_TOKEN_STORAGE_KEY,
  inviteKeyFromHash,
  parseBearer,
  parseClientMessage,
  parseServerMessage,
  parseShareAuthorization,
  type Furniture,
} from "../src/index";

/** 16 random bytes, base64url without padding, as the server mints owner tokens and invite keys (ADR 0028). */
function mint(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");
}

const ok = (schema: v.GenericSchema, value: unknown): boolean => v.safeParse(schema, value).success;
const utf8 = (s: string): number => new TextEncoder().encode(s).length;

describe("room limits (ADR 0028)", () => {
  test("creation, cap, GC and edit limits have the plan's values", () => {
    expect([ROOM_CREATE_KEY_BURST, ROOM_CREATE_KEY_REFILL_MS]).toEqual([2, 600_000]);
    expect([ROOM_CREATE_GLOBAL_BURST, ROOM_CREATE_GLOBAL_REFILL_MS]).toEqual([10, 60_000]);
    expect(MAX_ROOMS).toBe(500);
    expect(ROOM_GC_NEVER_JOINED_MS).toBe(60 * 60 * 1000);
    expect(ROOM_GC_EMPTY_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(ROOM_GC_SWEEP_MS).toBe(60 * 60 * 1000);
    expect([ROOM_EDIT_BURST, ROOM_EDIT_REFILL_MS]).toEqual([2, 2000]);
    expect(ROOM_TITLE_MAX_LENGTH).toBe(32);
    expect(MAX_CREATE_BODY_BYTES).toBe(1024);
  });

  test("ROOM_CLOSED is 4004 and no other close code uses it", () => {
    expect(CLOSE_CODES.ROOM_CLOSED).toBe(4004);
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("owner token and invite key", () => {
  test("accept a minted 22-char base64url value and nothing else", () => {
    for (const schema of [OwnerTokenSchema, InviteKeySchema]) {
      expect(ok(schema, mint())).toBe(true);
      expect(ok(schema, "a".repeat(21))).toBe(false);
      expect(ok(schema, "a".repeat(23))).toBe(false);
      expect(ok(schema, `${"a".repeat(21)}+`)).toBe(false);
      expect(ok(schema, `${"a".repeat(21)}=`)).toBe(false);
    }
  });

  test("parseBearer reads an Authorization header and never throws", () => {
    const token = mint();
    expect(parseBearer(`Bearer ${token}`)).toBe(token);
    expect(parseBearer(`bearer ${token}`)).toBe(token);
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(undefined)).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer(`Bearer  ${token}`)).toBeNull();
    expect(parseBearer(`Basic ${token}`)).toBeNull();
    expect(parseBearer(`Bearer ${token}x`)).toBeNull();
    expect(parseBearer(`Bearer ${"a".repeat(1_000_000)}`)).toBeNull();
  });

  test("parseShareAuthorization stays as the share endpoint's name for parseBearer", () => {
    const token = mint();
    expect(parseShareAuthorization(`Bearer ${token}`)).toBe(token);
    expect(parseShareAuthorization("Bearer short")).toBeNull();
  });

  test("inviteKeyFromHash reads exactly `#k=<key>` and nothing else", () => {
    const key = mint();
    expect(inviteKeyFromHash(`#k=${key}`)).toBe(key);
    expect(inviteKeyFromHash("")).toBeNull();
    expect(inviteKeyFromHash("#")).toBeNull();
    expect(inviteKeyFromHash(`k=${key}`)).toBeNull();
    expect(inviteKeyFromHash(`#x=${key}`)).toBeNull();
    expect(inviteKeyFromHash(`#k=${key}&a=1`)).toBeNull();
    expect(inviteKeyFromHash(`#k=${key.slice(1)}`)).toBeNull();
    expect(inviteKeyFromHash(`#k=${key.slice(1)}+`)).toBeNull();
    expect(inviteKeyFromHash(`#k=${"a".repeat(1_000_000)}`)).toBeNull();
  });
});

describe("RoomTitleSchema", () => {
  const title = (s: string): string | null => {
    const r = v.safeParse(RoomTitleSchema, s);
    return r.success ? r.output : null;
  };

  test("accepts plain titles with a little punctuation", () => {
    expect(title("Friday films")).toBe("Friday films");
    expect(title("Tom's movie night!")).toBe("Tom's movie night!");
    expect(title("Anime & chill (EU)")).toBe("Anime & chill (EU)");
    expect(title("Café #2")).toBe("Café #2");
  });

  test("normalises NFKC, then trims", () => {
    expect(title("  Ｆｉｌｍｓ  ")).toBe("Films");
  });

  test("length is 1 to ROOM_TITLE_MAX_LENGTH units", () => {
    expect(title("")).toBeNull();
    expect(title("   ")).toBeNull();
    expect(title("a".repeat(ROOM_TITLE_MAX_LENGTH))).not.toBeNull();
    expect(title("a".repeat(ROOM_TITLE_MAX_LENGTH + 1))).toBeNull();
  });

  test("refuses controls, bidi, zero-width, markup, emoji and double spaces", () => {
    for (const bad of ["a\u0000b", "a\u202Eb", "a\u200Bb", "a\u200Db", "<b>x</b>", "a/b", "film 🎬", "a  b", "a\nb", "\u3164"]) {
      expect(title(bad)).toBeNull();
    }
  });

  test("refuses keycap emoji built from a digit or # and combining marks", () => {
    expect(title("Room #\uFE0F\u20E3")).toBeNull();
    expect(title("Room 1\uFE0F\u20E3")).toBeNull();
    expect(title("Room 1\u20E3")).toBeNull();
    expect(title("Room \u2764\uFE0E")).toBeNull();
  });

  test("refuses mixed Latin and Cyrillic, and mark stacks", () => {
    expect(title("Fil\u043Cs")).toBeNull();
    expect(title(`x${"\u0301".repeat(2)}`)).not.toBeNull();
    expect(title(`x${"\u0301".repeat(3)}`)).toBeNull();
    expect(title("Филь\u043Cы")).toBe("Филь\u043Cы");
  });
});

describe("POST /rooms and DELETE /rooms/:id", () => {
  const id = "k3v4m5n6p7q2r3s4t5u6v7w2x3";

  test("the request is strict: a title and a visibility", () => {
    expect(ok(CreateRoomRequestSchema, { title: "Friday films", visibility: "public" })).toBe(true);
    expect(ok(CreateRoomRequestSchema, { title: "Friday films", visibility: "private" })).toBe(true);
    expect(ok(CreateRoomRequestSchema, { title: "Friday films", visibility: "secret" })).toBe(false);
    expect(ok(CreateRoomRequestSchema, { title: "Friday films" })).toBe(false);
    expect(ok(CreateRoomRequestSchema, { title: "Friday films", visibility: "public", id: "lobby" })).toBe(false);
    expect(utf8(JSON.stringify({ title: "a".repeat(ROOM_TITLE_MAX_LENGTH), visibility: "private" }))).toBeLessThan(MAX_CREATE_BODY_BYTES);
  });

  test("a created room carries an owner token, and an invite key iff it is private", () => {
    const room = (visibility: string) => ({ id, title: "Friday films", visibility });
    expect(ok(CreateRoomResponseSchema, { ok: true, room: room("public"), ownerToken: mint() })).toBe(true);
    expect(ok(CreateRoomResponseSchema, { ok: true, room: room("private"), ownerToken: mint(), inviteKey: mint() })).toBe(true);
    expect(ok(CreateRoomResponseSchema, { ok: true, room: room("private"), ownerToken: mint() })).toBe(false);
    expect(ok(CreateRoomResponseSchema, { ok: true, room: room("public"), ownerToken: mint(), inviteKey: mint() })).toBe(false);
    expect(ok(CreateRoomResponseSchema, { ok: true, room: room("public") })).toBe(false);
  });

  test("creation errors include too_many_rooms and rate_limited with retryAfterMs", () => {
    for (const code of ["invalid_body", "payload_too_large", "rate_limited", "too_many_rooms"]) {
      expect(ok(CreateRoomResponseSchema, { ok: false, error: { code, message: "no" } })).toBe(true);
    }
    expect(ok(CreateRoomResponseSchema, { ok: false, error: { code: "rate_limited", message: "slow", retryAfterMs: 1000 } })).toBe(true);
    expect(ok(CreateRoomResponseSchema, { ok: false, error: { code: "room_not_found", message: "no" } })).toBe(false);
  });

  test("delete answers ok or room_not_found / unauthorized / rate_limited", () => {
    expect(ok(DeleteRoomResponseSchema, { ok: true })).toBe(true);
    for (const code of ["room_not_found", "unauthorized", "rate_limited"]) {
      expect(ok(DeleteRoomResponseSchema, { ok: false, error: { code, message: "no" } })).toBe(true);
    }
    expect(ok(DeleteRoomResponseSchema, { ok: false, error: { code: "too_many_rooms", message: "no" } })).toBe(false);
  });

  test("create and delete answer 503 unavailable when the store write fails (OME-441)", () => {
    expect(ok(CreateRoomResponseSchema, { ok: false, error: { code: "unavailable", message: "try again" } })).toBe(true);
    expect(ok(DeleteRoomResponseSchema, { ok: false, error: { code: "unavailable", message: "try again" } })).toBe(true);
  });

  test("the creation 429 carries the full key refill wait; share and WS keep the 60 s cap (OME-441)", () => {
    expect(ROOM_CREATE_RETRY_AFTER_MAX_MS).toBe(ROOM_CREATE_KEY_REFILL_MS);
    const created = (retryAfterMs: number) => ({ ok: false, error: { code: "rate_limited", message: "slow", retryAfterMs } });
    expect(ok(CreateRoomResponseSchema, created(ROOM_CREATE_KEY_REFILL_MS))).toBe(true);
    expect(ok(CreateRoomResponseSchema, created(ROOM_CREATE_KEY_REFILL_MS + 1))).toBe(false);
    expect(ok(CreateRoomResponseSchema, created(-1))).toBe(false);
    expect(ok(CreateRoomResponseSchema, created(1.5))).toBe(false);
    // Delete's failure bucket refills at 1/s: it keeps the shared cap.
    expect(ok(DeleteRoomResponseSchema, created(RETRY_AFTER_MAX_MS))).toBe(true);
    expect(ok(DeleteRoomResponseSchema, created(RETRY_AFTER_MAX_MS + 1))).toBe(false);
    expect(ok(ShareResponseSchema, created(RETRY_AFTER_MAX_MS + 1))).toBe(false);
    const wsError = { type: "error", code: "rate_limited", message: "", retryAfterMs: RETRY_AFTER_MAX_MS + 1 };
    expect(ok(ServerMessageSchema, wsError)).toBe(false);
  });

  test("a room summary may carry a title", () => {
    const summary = { id, memberCount: 1, seatedCount: 0 };
    expect(ok(RoomSummarySchema, summary)).toBe(true);
    expect(v.parse(RoomSummarySchema, { ...summary, title: "Friday films" }).title).toBe("Friday films");
    expect(ok(RoomSummarySchema, { ...summary, title: "a\u202Eb" })).toBe(false);
  });
});

describe("site storage for room secrets", () => {
  test("is its own key, never the share record the extension reads", () => {
    expect(ROOM_SECRETS_STORAGE_KEY).toBe("omega.rooms");
    expect(ROOM_SECRETS_STORAGE_KEY).not.toBe(SHARE_TOKEN_STORAGE_KEY);
  });

  test("holds owner tokens and invite keys by room id, strictly, at most MAX_ROOM_SECRETS rooms", () => {
    const rooms = { lobby: { inviteKey: mint() }, k3v4: { ownerToken: mint(), inviteKey: mint() } };
    expect(ok(RoomSecretsSchema, { v: 1, rooms })).toBe(true);
    expect(ok(RoomSecretsSchema, { v: 2, rooms })).toBe(false);
    expect(ok(RoomSecretsSchema, { v: 1, rooms: { lobby: { shareToken: mint() } } })).toBe(false);
    expect(ok(RoomSecretsSchema, { v: 1, rooms: { "Not An Id": {} } })).toBe(false);
    const many = Object.fromEntries(Array.from({ length: MAX_ROOM_SECRETS + 1 }, (_, i) => [`r${String(i)}`, { ownerToken: mint() }]));
    expect(ok(RoomSecretsSchema, { v: 1, rooms: many })).toBe(false);
  });
});

/** A valid layout with MAX_FURNITURE pieces, every optional field present (the biggest real `layout-set`). */
function fullLayout(): { furniture: Furniture[] } {
  const wallSegments = [0, 1, 2, 3, 4, 7, 9];
  const furniture: Furniture[] = [
    ...DEFAULT_LAYOUT.furniture.map((f) => ({ ...f, variant: 0 })),
    ...wallSegments.map((col): Furniture => ({ kind: "frame", col, row: 0, facing: "sw", variant: 1 })),
    ...wallSegments.map((row): Furniture => ({ kind: "frame", col: 0, row, facing: "se", variant: 1 })),
  ];
  for (const [col, row] of [[8, 8], [9, 9], [9, 5], [5, 9], [9, 7], [7, 9], [8, 6], [6, 8], [9, 2], [2, 9]] as const) {
    if (furniture.length === MAX_FURNITURE) break;
    furniture.push({ kind: "monstera", col, row, facing: "sw", variant: 1 });
  }
  return { furniture };
}

describe("RoomLayoutInputSchema", () => {
  test("accepts what RoomLayoutSchema accepts", () => {
    for (const layout of [DEFAULT_LAYOUT, fullLayout()]) {
      expect(ok(RoomLayoutSchema, layout)).toBe(true);
      expect(ok(RoomLayoutInputSchema, layout)).toBe(true);
    }
  });

  test("applies the same layout rules", () => {
    const twoTvs = { furniture: [...DEFAULT_LAYOUT.furniture, { kind: "tv", col: 9, row: 9, facing: "se" }] };
    const tooMany = { furniture: [...fullLayout().furniture, { kind: "popcorn", col: 8, row: 0, facing: "sw" }] };
    for (const bad of [twoTvs, tooMany, { furniture: DEFAULT_LAYOUT.furniture.slice(1) }]) {
      expect(ok(RoomLayoutSchema, bad)).toBe(false);
      expect(ok(RoomLayoutInputSchema, bad)).toBe(false);
    }
  });

  test("refuses unknown keys on the layout and on each piece; the server → client schema strips them", () => {
    const extraPiece = { furniture: DEFAULT_LAYOUT.furniture.map((f, i) => (i === 0 ? { ...f, id: 1 } : f)) };
    const extraLayout = { ...DEFAULT_LAYOUT, name: "x" };
    for (const layout of [extraPiece, extraLayout]) {
      expect(ok(RoomLayoutInputSchema, layout)).toBe(false);
      expect(ok(RoomLayoutSchema, layout)).toBe(true);
    }
  });
});

describe("room ownership on the socket", () => {
  const join = { type: "join", nickname: "Alice", avatar: 0 };

  test("join may carry an owner token and an invite key", () => {
    expect(parseClientMessage(JSON.stringify({ ...join, ownerToken: mint(), inviteKey: mint() }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...join, inviteKey: mint() }))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify(join))).not.toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...join, ownerToken: "short" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ ...join, shareToken: mint() }))).toBeNull();
  });

  test("layout-set carries a whole, strict layout", () => {
    expect(parseClientMessage(JSON.stringify({ type: "layout-set", layout: DEFAULT_LAYOUT }))).toEqual({ type: "layout-set", layout: DEFAULT_LAYOUT });
    const extra = { furniture: DEFAULT_LAYOUT.furniture.map((f) => ({ ...f, z: 1 })) };
    expect(parseClientMessage(JSON.stringify({ type: "layout-set", layout: extra }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "layout-set", layout: { furniture: [] } }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "layout-set", layout: DEFAULT_LAYOUT, by: "m1" }))).toBeNull();
  });

  test("title-set carries a valid title", () => {
    expect(parseClientMessage(JSON.stringify({ type: "title-set", title: " Ｆｉｌｍｓ " }))).toEqual({ type: "title-set", title: "Films" });
    expect(parseClientMessage(JSON.stringify({ type: "title-set", title: "a\u202Eb" }))).toBeNull();
  });

  test("the joiner's snapshot may say it is the owner", () => {
    const room = { id: "lobby", seats: Array(8).fill(null), members: [], embed: null, playback: null };
    const msg = parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room, owner: true }));
    expect(msg?.type === "snapshot" ? msg.owner : undefined).toBe(true);
    const plain = parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room }));
    expect(plain?.type === "snapshot" ? plain.owner : "missing").toBeUndefined();
  });

  test("the snapshot may carry the room's title, parsed as a title", () => {
    const room = { id: "lobby", seats: Array(8).fill(null), members: [], embed: null, playback: null };
    const titled = parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room: { ...room, title: " Ｆｒｉｄａｙ films " } }));
    expect(titled?.type === "snapshot" ? titled.room.title : undefined).toBe("Friday films");
    const untitled = parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room }));
    expect(untitled?.type === "snapshot" ? untitled.room.title : "missing").toBeUndefined();
    for (const title of ["", "a<b", "a\u202Eb", "x".repeat(ROOM_TITLE_MAX_LENGTH + 1), null, 7]) {
      expect(parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room: { ...room, title } }))).toBeNull();
    }
  });

  test("layout-changed and title-changed say who changed it", () => {
    expect(parseServerMessage(JSON.stringify({ type: "layout-changed", layout: DEFAULT_LAYOUT, by: "m1" }))).toEqual({ type: "layout-changed", layout: DEFAULT_LAYOUT, by: "m1" });
    expect(parseServerMessage(JSON.stringify({ type: "title-changed", title: "Friday films", by: "m1" }))).toEqual({ type: "title-changed", title: "Friday films", by: "m1" });
    expect(parseServerMessage(JSON.stringify({ type: "layout-changed", layout: { furniture: [] }, by: "m1" }))).toBeNull();
  });

  test("errors include invite_required and not_owner", () => {
    for (const code of ["invite_required", "not_owner"]) {
      expect(parseServerMessage(JSON.stringify({ type: "error", code, message: "no" }))).not.toBeNull();
    }
  });
});

describe("frame sizes", () => {
  test("a full valid layout-set parses and fits MAX_CLIENT_MESSAGE_BYTES", () => {
    const layout = fullLayout();
    expect(layout.furniture).toHaveLength(MAX_FURNITURE);
    const raw = JSON.stringify({ type: "layout-set", layout });
    expect(utf8(raw)).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_BYTES);
    expect(parseClientMessage(raw)).not.toBeNull();
  });

  test("even MAX_FURNITURE of the longest kind name, all fields set, fits with half the cap to spare", () => {
    const longest = FURNITURE_KINDS.reduce((a, b) => (b.length > a.length ? b : a));
    const variant = Math.max(...Object.values(FURNITURE).map((s) => s.variants - 1));
    const piece = { kind: longest, col: 9, row: 9, facing: "sw", variant };
    const raw = JSON.stringify({ type: "layout-set", layout: { furniture: Array<typeof piece>(MAX_FURNITURE).fill(piece) } });
    expect(utf8(raw)).toBeLessThanOrEqual(MAX_CLIENT_MESSAGE_BYTES / 2 + 256);
  });

  test("join with both secrets and a worst-case title-set stay small", () => {
    const join = JSON.stringify({ type: "join", nickname: "\u{10400}".repeat(10), avatar: 3, ownerToken: mint(), inviteKey: mint() });
    expect(utf8(join)).toBeLessThan(256);
    const titleSet = JSON.stringify({ type: "title-set", title: "\u0800".repeat(ROOM_TITLE_MAX_LENGTH) });
    expect(utf8(titleSet)).toBeLessThan(256);
  });
});
