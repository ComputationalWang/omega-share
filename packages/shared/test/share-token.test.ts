import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  SHARE_ERROR_CODES,
  SHARE_TOKEN_LENGTH,
  SHARE_TOKEN_STORAGE_KEY,
  ServerMessageSchema,
  ShareResponseSchema,
  ShareTokenRecordSchema,
  ShareTokenSchema,
  parseServerMessage,
  parseShareAuthorization,
} from "../src/index";

/** 16 random bytes, base64url without padding, as the server mints them (ADR 0015). */
function mint(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Buffer.from(bytes).toString("base64url");
}

const TOKEN = "AbCdEfGhIjKlMnOpQr_-09";
const ROOM = { id: "lobby", seats: Array.from({ length: 8 }, () => null), members: [], embed: null };

describe("ShareTokenSchema", () => {
  test("is 22 base64url characters (128 bits, no padding)", () => {
    expect(SHARE_TOKEN_LENGTH).toBe(22);
    expect(TOKEN).toHaveLength(SHARE_TOKEN_LENGTH);
    expect(v.safeParse(ShareTokenSchema, TOKEN).success).toBe(true);
  });

  test("accepts freshly minted tokens", () => {
    for (let i = 0; i < 64; i++) {
      const token = mint();
      expect(token).toHaveLength(SHARE_TOKEN_LENGTH);
      expect(v.safeParse(ShareTokenSchema, token).success).toBe(true);
    }
  });

  const invalid: [string, unknown][] = [
    ["empty", ""],
    ["too short", TOKEN.slice(1)],
    ["too long", `${TOKEN}A`],
    ["base64 padding", `${TOKEN.slice(0, 20)}==`],
    ["standard-base64 '+'", `${TOKEN.slice(0, 21)}+`],
    ["standard-base64 '/'", `${TOKEN.slice(0, 21)}/`],
    ["space", `${TOKEN.slice(0, 21)} `],
    ["surrounding whitespace", ` ${TOKEN.slice(1)}`],
    ["non-ASCII letter", `${TOKEN.slice(0, 21)}é`],
    ["newline", `${TOKEN.slice(0, 21)}\n`],
    ["number", 1234],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [name, input] of invalid) {
    test(`rejects ${name}`, () => {
      expect(v.safeParse(ShareTokenSchema, input).success).toBe(false);
    });
  }
});

describe("parseShareAuthorization", () => {
  test("returns the token from `Bearer <token>`", () => {
    expect(parseShareAuthorization(`Bearer ${TOKEN}`)).toBe(TOKEN);
  });

  test("the scheme is case-insensitive (RFC 9110 §11.1)", () => {
    expect(parseShareAuthorization(`bearer ${TOKEN}`)).toBe(TOKEN);
    expect(parseShareAuthorization(`BEARER ${TOKEN}`)).toBe(TOKEN);
  });

  const rejected: [string, string | null | undefined][] = [
    ["missing header (null)", null],
    ["missing header (undefined)", undefined],
    ["empty header", ""],
    ["scheme only", "Bearer"],
    ["scheme and space only", "Bearer "],
    ["bare token without scheme", TOKEN],
    ["Basic scheme", `Basic ${TOKEN}`],
    ["no space after scheme", `Bearer${TOKEN}`],
    ["two spaces", `Bearer  ${TOKEN}`],
    ["tab separator", `Bearer\t${TOKEN}`],
    ["trailing garbage", `Bearer ${TOKEN} x`],
    ["two tokens", `Bearer ${TOKEN}, Bearer ${TOKEN}`],
    ["garbled token", `Bearer ${TOKEN.slice(0, 21)}!`],
    ["short token", `Bearer ${TOKEN.slice(2)}`],
    ["long token", `Bearer ${TOKEN}AA`],
    ["padded token", `Bearer ${TOKEN.slice(0, 20)}==`],
    ["huge header", `Bearer ${"A".repeat(100_000)}`],
  ];
  for (const [name, header] of rejected) {
    test(`rejects ${name}`, () => {
      expect(parseShareAuthorization(header)).toBeNull();
    });
  }
});

describe("snapshot.shareToken", () => {
  test("a snapshot carries the recipient's share token", () => {
    const frame = JSON.stringify({ type: "snapshot", self: "m1", room: ROOM, shareToken: TOKEN });
    const msg = parseServerMessage(frame);
    expect(msg?.type === "snapshot" ? msg.shareToken : "wrong type").toBe(TOKEN);
  });

  test("is optional so pre-M2 servers still parse (absent → cannot share)", () => {
    const msg = parseServerMessage(JSON.stringify({ type: "snapshot", self: "m1", room: ROOM }));
    expect(msg?.type === "snapshot" ? msg.shareToken : "wrong type").toBeUndefined();
  });

  for (const [name, shareToken] of [
    ["garbled", `${TOKEN.slice(0, 21)}!`],
    ["short", TOKEN.slice(1)],
    ["null", null],
    ["number", 7],
  ] as const) {
    test(`rejects a snapshot with a ${name} share token`, () => {
      expect(v.safeParse(ServerMessageSchema, { type: "snapshot", self: "m1", room: ROOM, shareToken }).success).toBe(false);
    });
  }
});

describe("ShareTokenRecordSchema (sessionStorage, site → extension)", () => {
  test("storage key is fixed", () => {
    expect(SHARE_TOKEN_STORAGE_KEY).toBe("omega.share");
  });

  test("accepts { roomId, token }", () => {
    expect(v.safeParse(ShareTokenRecordSchema, { roomId: "lobby", token: TOKEN }).success).toBe(true);
  });

  const invalid: [string, unknown][] = [
    ["missing token", { roomId: "lobby" }],
    ["missing roomId", { token: TOKEN }],
    ["garbled token", { roomId: "lobby", token: "not-a-token" }],
    ["bad room id", { roomId: "Lobby!", token: TOKEN }],
    ["extra key", { roomId: "lobby", token: TOKEN, memberId: "m1" }],
    ["string (unparsed JSON)", JSON.stringify({ roomId: "lobby", token: TOKEN })],
    ["null (nothing stored)", null],
  ];
  for (const [name, input] of invalid) {
    test(`rejects ${name}`, () => {
      expect(v.safeParse(ShareTokenRecordSchema, input).success).toBe(false);
    });
  }
});

describe("share errors", () => {
  test("`unauthorized` is a share error code (HTTP 401)", () => {
    expect(SHARE_ERROR_CODES).toContain("unauthorized");
    const body = { ok: false, error: { code: "unauthorized", message: "join the room to share" } };
    expect(v.safeParse(ShareResponseSchema, body).success).toBe(true);
  });
});
