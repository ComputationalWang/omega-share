import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  AVATAR_COUNT,
  CHAT_MAX_LENGTH,
  ClientMessageSchema,
  DEFAULT_ROOM_ID,
  MAX_CLIENT_MESSAGE_BYTES,
  MAX_SERVER_MESSAGE_BYTES,
  MAX_ROOM_MEMBERS,
  NICKNAME_MAX_LENGTH,
  NicknameSchema,
  RoomIdSchema,
  RoomStateSchema,
  SEAT_COUNT,
  ServerMessageSchema,
  ShareRequestSchema,
  ShareResponseSchema,
  parseClientMessage,
  parseServerMessage,
} from "../src/index";

const EMBED = { provider: "youtube", videoId: "dQw4w9WgXcQ", url: "https://www.youtube.com/embed/dQw4w9WgXcQ" };
const ALICE = { id: "m1", nickname: "alice", avatar: 0 };
const BOB = { id: "m2", nickname: "Bob 2", avatar: 3 };
const emptySeats = (): (string | null)[] => Array.from({ length: 8 }, () => null);

function room(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const seats = emptySeats();
  seats[2] = "m1";
  return { id: "lobby", seats, members: [ALICE, BOB], embed: EMBED, ...overrides };
}

function cases(schema: v.GenericSchema, valid: readonly unknown[], invalid: readonly [string, unknown][]): void {
  for (const input of valid) {
    test(`accepts ${JSON.stringify(input)}`, () => {
      const result = v.safeParse(schema, input);
      expect(result.issues).toBeUndefined();
    });
  }
  for (const [name, input] of invalid) {
    test(`rejects ${name}`, () => {
      expect(v.safeParse(schema, input).success).toBe(false);
    });
  }
}

describe("constants", () => {
  test("M1a values", () => {
    expect(DEFAULT_ROOM_ID).toBe("lobby");
    expect(SEAT_COUNT).toBe(8);
    expect(AVATAR_COUNT).toBe(4);
    expect(CHAT_MAX_LENGTH).toBe(280);
    expect(NICKNAME_MAX_LENGTH).toBe(20);
    expect(MAX_ROOM_MEMBERS).toBe(25);
    expect(MAX_CLIENT_MESSAGE_BYTES).toBe(4096);
    expect(MAX_SERVER_MESSAGE_BYTES).toBe(65536);
  });
});

describe("RoomIdSchema", () => {
  cases(RoomIdSchema, ["lobby", "room-1", "a"], [
    ["empty", ""],
    ["uppercase", "Lobby"],
    ["slash", "a/b"],
    ["too long", "a".repeat(33)],
    ["number", 1],
  ]);
});

describe("NicknameSchema", () => {
  cases(NicknameSchema, ["alice", "Bob 2", "zoë", "李雷", "हिन्दी", "a.b_c-d", "x".repeat(20)], [
    ["empty", ""],
    ["only spaces", "   "],
    ["too long", "x".repeat(21)],
    ["html", "<b>hi</b>"],
    ["emoji", "cool😎"],
    ["newline", "a\nb"],
    ["zero-width joiner", "a\u200db"],
    ["rtl override", "a\u202eb"],
    ["double space", "a  b"],
    ["hangul filler", "\u3164"],
    ["halfwidth hangul filler", "a\uffa0b"],
    ["leading combining mark", "\u0301a"],
    ["number", 42],
  ]);

  test("trims and NFC-normalizes", () => {
    expect(v.parse(NicknameSchema, "  zoë ")).toBe("zoë");
  });
});

describe("RoomStateSchema", () => {
  const seats = emptySeats();
  seats[0] = "m1";
  seats[7] = "m2";
  cases(
    RoomStateSchema,
    [room(), room({ embed: null }), room({ members: [], seats: emptySeats() }), room({ seats })],
    [
      ["7 seats", room({ seats: emptySeats().slice(1) })],
      ["9 seats", room({ seats: [...emptySeats(), null] })],
      ["seat occupant not a member", room({ seats: ["ghost", ...emptySeats().slice(1)] })],
      ["member in two seats", room({ seats: ["m1", "m1", ...emptySeats().slice(2)] })],
      ["duplicate member id", room({ members: [ALICE, { ...BOB, id: "m1" }] })],
      ["avatar out of range", room({ members: [{ ...ALICE, avatar: 4 }] })],
      ["avatar not integer", room({ members: [{ ...ALICE, avatar: 1.5 }] })],
      ["bad nickname", room({ members: [{ ...ALICE, nickname: "" }] })],
      ["too many members", room({ seats: emptySeats(), members: Array.from({ length: 26 }, (_, i) => ({ ...ALICE, id: `m${String(i)}` })) })],
      ["non-allowlisted embed", room({ embed: { ...EMBED, url: "https://evil.example/" } })],
      ["missing embed", { id: "lobby", seats: emptySeats(), members: [] }],
      ["bad room id", room({ id: "../etc" })],
    ],
  );
});

describe("ShareRequestSchema", () => {
  cases(ShareRequestSchema, [{ url: "https://youtu.be/dQw4w9WgXcQ" }, { url: "anything — server canonicalizes" }], [
    ["missing url", {}],
    ["url not string", { url: 1 }],
    ["url over cap", { url: "a".repeat(2049) }],
    ["extra keys", { url: "https://youtu.be/dQw4w9WgXcQ", provider: "youtube" }],
    ["null", null],
  ]);
});

describe("ShareResponseSchema", () => {
  cases(
    ShareResponseSchema,
    [
      { ok: true, embed: EMBED },
      { ok: false, error: { code: "unsupported_url", message: "Only YouTube is supported" } },
      { ok: false, error: { code: "invalid_body", message: "" } },
      { ok: false, error: { code: "room_not_found", message: "no such room" } },
      { ok: false, error: { code: "rate_limited", message: "slow down" } },
    ],
    [
      ["ok without embed", { ok: true }],
      ["ok with bad embed", { ok: true, embed: { ...EMBED, videoId: "x" } }],
      ["unknown error code", { ok: false, error: { code: "teapot", message: "" } }],
      ["error without message", { ok: false, error: { code: "invalid_body" } }],
      ["missing ok", { embed: EMBED }],
    ],
  );
});

describe("ClientMessageSchema", () => {
  cases(
    ClientMessageSchema,
    [
      { type: "join", nickname: "alice", avatar: 0 },
      { type: "join", nickname: "alice", avatar: 3 },
      { type: "leave" },
      { type: "sit", seat: 0 },
      { type: "sit", seat: 7 },
      { type: "sit", seat: null },
      { type: "chat", text: "hello" },
      { type: "chat", text: "x".repeat(280) },
      { type: "chat", text: "emoji ok 🎉 and <b>tags</b> are just text" },
      { type: "chat", text: "family \u{1F468}\u200d\u{1F469}\u200d\u{1F467} ok" },
      { type: "chat", text: "ok 👍" },
    ],
    [
      ["unknown type", { type: "kick", id: "m1" }],
      ["missing type", { nickname: "alice", avatar: 0 }],
      ["join bad nickname", { type: "join", nickname: "", avatar: 0 }],
      ["join avatar 4", { type: "join", nickname: "alice", avatar: 4 }],
      ["join avatar -1", { type: "join", nickname: "alice", avatar: -1 }],
      ["join extra keys", { type: "join", nickname: "alice", avatar: 0, admin: true }],
      ["sit seat 8", { type: "sit", seat: 8 }],
      ["sit seat string", { type: "sit", seat: "1" }],
      ["sit seat float", { type: "sit", seat: 0.5 }],
      ["chat empty", { type: "chat", text: "" }],
      ["chat whitespace", { type: "chat", text: "   " }],
      ["chat too long", { type: "chat", text: "x".repeat(281) }],
      ["chat control chars", { type: "chat", text: "a\u0000b" }],
      ["chat bidi override", { type: "chat", text: "a\u202eb" }],
      ["chat zero-width space only", { type: "chat", text: "\u200b" }],
      ["chat zero-width space inside", { type: "chat", text: "a\u200bb" }],
      ["chat BOM inside", { type: "chat", text: "h\ufeffi" }],
      ["chat line separator", { type: "chat", text: "a\u2028b" }],
      ["chat ZWJ only", { type: "chat", text: "\u200d" }],
      ["chat variation selector only", { type: "chat", text: "\ufe0f" }],
      ["chat hangul filler only", { type: "chat", text: "\u3164" }],
      ["server-only type", { type: "snapshot", self: "m1", room: room() }],
      ["not an object", "join"],
    ],
  );

  test("chat text is trimmed", () => {
    expect(v.parse(ClientMessageSchema, { type: "chat", text: "  hi  " })).toEqual({ type: "chat", text: "hi" });
  });
});

describe("ServerMessageSchema", () => {
  cases(
    ServerMessageSchema,
    [
      { type: "snapshot", self: "m1", room: room() },
      { type: "member-joined", member: ALICE },
      { type: "member-left", memberId: "m1" },
      { type: "seat-changed", memberId: "m1", seat: 3 },
      { type: "seat-changed", memberId: "m1", seat: null },
      { type: "chat", memberId: "m1", text: "hello", at: 1_790_000_000_000 },
      { type: "embed-changed", embed: EMBED, by: "m1" },
      { type: "embed-changed", embed: EMBED, by: null },
      { type: "embed-changed", embed: null, by: null },
      { type: "room-full" },
      { type: "error", code: "bad_message", message: "invalid" },
      { type: "error", code: "not_joined", message: "" },
      { type: "error", code: "already_joined", message: "" },
      { type: "error", code: "seat_taken", message: "" },
      { type: "error", code: "rate_limited", message: "" },
    ],
    [
      ["snapshot with invalid room", { type: "snapshot", self: "m1", room: room({ seats: [] }) }],
      ["member-joined bad avatar", { type: "member-joined", member: { ...ALICE, avatar: 9 } }],
      ["seat-changed seat 8", { type: "seat-changed", memberId: "m1", seat: 8 }],
      ["chat too long", { type: "chat", memberId: "m1", text: "x".repeat(281), at: 0 }],
      ["chat missing at", { type: "chat", memberId: "m1", text: "hi" }],
      ["embed-changed arbitrary url", { type: "embed-changed", embed: { ...EMBED, url: "javascript:alert(1)" }, by: null }],
      ["unknown error code", { type: "error", code: "oops", message: "" }],
      ["client-only type", { type: "join", nickname: "alice", avatar: 0 }],
    ],
  );
});

describe("parseClientMessage", () => {
  test("parses a valid JSON frame", () => {
    expect(parseClientMessage('{"type":"sit","seat":4}')).toEqual({ type: "sit", seat: 4 });
  });

  test("returns null for invalid JSON", () => {
    expect(parseClientMessage("{nope")).toBeNull();
  });

  test("returns null for a schema-invalid frame", () => {
    expect(parseClientMessage('{"type":"sit","seat":99}')).toBeNull();
  });

  test("returns null for an oversized frame without parsing it", () => {
    const big = JSON.stringify({ type: "chat", text: "x".repeat(MAX_CLIENT_MESSAGE_BYTES) });
    expect(parseClientMessage(big)).toBeNull();
  });

  test("counts bytes, not UTF-16 units", () => {
    // 1400 × 3-byte chars = 4200 bytes but only 1400 UTF-16 units.
    expect(parseClientMessage(JSON.stringify({ type: "chat", text: "€".repeat(1400) }))).toBeNull();
  });
});

describe("parseServerMessage", () => {
  test("accepts a worst-case full-room snapshot", () => {
    const members = Array.from({ length: 25 }, (_, i) => ({
      id: String(i).padStart(2, "0") + "x".repeat(62),
      nickname: "李".repeat(20),
      avatar: 3,
    }));
    const seats = members.slice(0, 8).map((m) => m.id);
    const frame = JSON.stringify({ type: "snapshot", self: members[0]?.id, room: { id: "a".repeat(32), seats, members, embed: EMBED } });
    expect(parseServerMessage(frame)?.type).toBe("snapshot");
  });

  test("returns null for a frame over the server limit", () => {
    const frame = JSON.stringify({ type: "room-full", pad: "x".repeat(MAX_SERVER_MESSAGE_BYTES) });
    expect(parseServerMessage(frame)).toBeNull();
  });

  test("parses a valid frame", () => {
    expect(parseServerMessage('{"type":"room-full"}')).toEqual({ type: "room-full" });
  });

  test("returns null for garbage", () => {
    expect(parseServerMessage("null")).toBeNull();
    expect(parseServerMessage("")).toBeNull();
  });
});
