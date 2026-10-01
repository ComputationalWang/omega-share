import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  CHAT_MAX_MARK_RUN,
  CLOSE_CODES,
  ClientMessageSchema,
  ERROR_CODES,
  MAX_EMBED_URL_LENGTH,
  MAX_URL_LENGTH,
  NICKNAME_MAX_LENGTH,
  NICKNAME_MAX_MARK_RUN,
  NicknameSchema,
  PLAYBACK_RATE_MAX,
  PLAYBACK_RATE_MIN,
  PlaybackStateSchema,
  RATE_LIMITED_RECONNECT_MS,
  RETRY_AFTER_MAX_MS,
  ROOM_ID_MAX_LENGTH,
  RetryAfterMsSchema,
  RoomIdSchema,
  ServerMessageSchema,
  ShareResponseSchema,
  normalizeNickname,
  parseClientMessage,
} from "../src/index";
import * as shared from "../src/index";

// M3 contract (OME-186, ADR 0016, docs/research/m3-threat-model.md §7).

function accepts(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).issues).toBeUndefined();
}
function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("shared limits", () => {
  test("values", () => {
    expect(ROOM_ID_MAX_LENGTH).toBe(32);
    expect(MAX_URL_LENGTH).toBe(2048);
    expect(MAX_EMBED_URL_LENGTH).toBe(128);
    expect(NICKNAME_MAX_MARK_RUN).toBe(2);
    expect(CHAT_MAX_MARK_RUN).toBe(3);
    expect(RETRY_AFTER_MAX_MS).toBe(60_000);
    expect(RATE_LIMITED_RECONNECT_MS).toBe(10_000);
    expect(PLAYBACK_RATE_MIN).toBe(0.25);
    expect(PLAYBACK_RATE_MAX).toBe(2);
  });

  test("room id: max accepted, max+1 and empty rejected", () => {
    accepts(RoomIdSchema, "a".repeat(32));
    rejects(RoomIdSchema, "a".repeat(33));
    rejects(RoomIdSchema, "");
  });

  test("playback rate: range edges, NaN and Infinity rejected", () => {
    const state = { playing: true, position: 0, at: 0, rev: 0, action: "play", by: null };
    accepts(PlaybackStateSchema, { ...state, rate: 0.25 });
    accepts(PlaybackStateSchema, { ...state, rate: 2 });
    rejects(PlaybackStateSchema, { ...state, rate: 0.24 });
    rejects(PlaybackStateSchema, { ...state, rate: 2.01 });
    rejects(PlaybackStateSchema, { ...state, rate: Number.NaN });
    rejects(PlaybackStateSchema, { ...state, rate: Number.POSITIVE_INFINITY });
  });

  test("control position: NaN, Infinity and 1e999 rejected", () => {
    const control = { type: "control", url: "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", playing: true };
    rejects(ClientMessageSchema, { ...control, position: Number.NaN });
    rejects(ClientMessageSchema, { ...control, position: Number.POSITIVE_INFINITY });
    expect(parseClientMessage(`{"type":"control","url":"${control.url}","playing":true,"position":1e999}`)).toBeNull();
  });
});

describe("CLOSE_CODES", () => {
  test("values are pinned", () => {
    expect(CLOSE_CODES).toEqual({
      HANDSHAKE_TIMEOUT: 4000,
      JOIN_TIMEOUT: 4001,
      ROOM_FULL: 4002,
      SLOW_CONSUMER: 4003,
      RATE_LIMITED: 4029,
      BAD_MESSAGES: 4400,
    });
  });

  test("all are in the application range and distinct", () => {
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    for (const c of codes) {
      expect(c).toBeGreaterThanOrEqual(4000);
      expect(c).toBeLessThanOrEqual(4999);
    }
  });
});

describe("RetryAfterMsSchema", () => {
  test("edges", () => {
    accepts(RetryAfterMsSchema, 0);
    accepts(RetryAfterMsSchema, 60_000);
    rejects(RetryAfterMsSchema, 60_001);
    rejects(RetryAfterMsSchema, -1);
    rejects(RetryAfterMsSchema, 1.5);
    rejects(RetryAfterMsSchema, Number.NaN);
    rejects(RetryAfterMsSchema, Number.POSITIVE_INFINITY);
    rejects(RetryAfterMsSchema, "100");
  });
});

describe("error message", () => {
  test("new codes", () => {
    expect(ERROR_CODES).toContain("nickname_taken");
    expect(ERROR_CODES).toContain("too_many_members");
    accepts(ServerMessageSchema, { type: "error", code: "nickname_taken", message: "" });
    accepts(ServerMessageSchema, { type: "error", code: "too_many_members", message: "" });
  });

  test("rate_limited carries retryAfterMs; absent is still valid (M2 servers)", () => {
    const parsed = v.parse(ServerMessageSchema, { type: "error", code: "rate_limited", message: "", retryAfterMs: 1500 });
    expect(parsed).toEqual({ type: "error", code: "rate_limited", message: "", retryAfterMs: 1500 });
    accepts(ServerMessageSchema, { type: "error", code: "rate_limited", message: "" });
    rejects(ServerMessageSchema, { type: "error", code: "rate_limited", message: "", retryAfterMs: 60_001 });
    rejects(ServerMessageSchema, { type: "error", code: "rate_limited", message: "", retryAfterMs: -1 });
  });

  test("share error carries retryAfterMs", () => {
    const body = { ok: false, error: { code: "rate_limited", message: "slow down", retryAfterMs: 3000 } } as const;
    expect(v.parse(ShareResponseSchema, body)).toEqual(body);
    accepts(ShareResponseSchema, { ok: false, error: { code: "rate_limited", message: "" } });
    rejects(ShareResponseSchema, { ok: false, error: { code: "rate_limited", message: "", retryAfterMs: 1.5 } });
  });
});

describe("NicknameSchema (M3)", () => {
  test("NFKC folds fullwidth and compatibility forms", () => {
    expect(v.parse(NicknameSchema, "Ａｌｉｃｅ")).toBe("Alice");
    expect(v.parse(NicknameSchema, "ｂｏｂ２")).toBe("bob2");
  });

  test("length is capped after normalising", () => {
    // U+FDFA is one unit that NFKC expands to 18 units ("صلى الله عليه وسلم").
    const expanded = "ﷺ".normalize("NFKC");
    expect(expanded.length).toBe(18);
    rejects(NicknameSchema, "abcﷺ");
    accepts(NicknameSchema, "x".repeat(NICKNAME_MAX_LENGTH));
    rejects(NicknameSchema, "x".repeat(NICKNAME_MAX_LENGTH + 1));
  });

  test("at most 2 combining marks in a row", () => {
    accepts(NicknameSchema, "x\u0301\u0302");
    rejects(NicknameSchema, "x\u0301\u0302\u0303");
    accepts(NicknameSchema, "हिन\u094Dदी");
  });

  test("Latin does not mix with Cyrillic, Greek, Armenian or Cherokee", () => {
    rejects(NicknameSchema, "Аlice"); // Cyrillic А
    rejects(NicknameSchema, "Aliοe"); // Greek ο
    rejects(NicknameSchema, "Aliցe"); // Armenian ց
    rejects(NicknameSchema, "Ꭺlice"); // Cherokee Ꭺ
    rejects(NicknameSchema, "bob боб"); // Latin word + Cyrillic word
    accepts(NicknameSchema, "Борис");
    accepts(NicknameSchema, "Σοφία");
    accepts(NicknameSchema, "Alice 李");
  });

  test("bidi and zero-width characters are rejected, not stripped", () => {
    for (const c of ["\u200B", "\u200C", "\u200D", "\u2060", "\uFEFF", "\u200E", "\u200F", "\u202E", "\u2066", "\u061C"]) {
      rejects(NicknameSchema, `al${c}ice`);
    }
  });

  test("empty after normalising is rejected", () => {
    rejects(NicknameSchema, "\u3000"); // ideographic space → " " → trimmed to ""
    rejects(NicknameSchema, " \u00A0 ");
  });

  test("join rejects extra keys and a mixed-script nickname", () => {
    rejects(ClientMessageSchema, { type: "join", nickname: "alice", avatar: 0, color: "red" });
    rejects(ClientMessageSchema, { type: "join", nickname: "Аlice", avatar: 0 });
    expect(v.parse(ClientMessageSchema, { type: "join", nickname: "Ａｌｉｃｅ", avatar: 0 })).toEqual({
      type: "join",
      nickname: "Alice",
      avatar: 0,
    });
  });
});

describe("normalizeNickname", () => {
  test("returns the normalised nickname or null; never throws", () => {
    expect(normalizeNickname("  Ａｌｉｃｅ ")).toBe("Alice");
    expect(normalizeNickname("zoe\u0308")).toBe("zoë");
    expect(normalizeNickname("")).toBeNull();
    expect(normalizeNickname("a\u200Bb")).toBeNull();
    expect(normalizeNickname(42)).toBeNull();
    expect(normalizeNickname(null)).toBeNull();
  });
});

describe("nicknameKey", () => {
  // OME-304: the M3 key is gone; the only key is the UTS #39 one in @omega/shared/confusables.
  test("is not exported from the main entry", () => {
    expect("nicknameKey" in shared).toBe(false);
  });
});

describe("ChatTextSchema (M3)", () => {
  const chat = (text: string): unknown => ({ type: "chat", text });

  test("NFC-normalised", () => {
    expect(v.parse(ClientMessageSchema, chat("zoe\u0308"))).toEqual({ type: "chat", text: "zoë" });
  });

  test("ZWJ only between pictographs", () => {
    for (const ok of ["\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", "❤\uFE0F\u200D\u{1F525}", "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}", "\u{1F3F3}\uFE0F\u200D\u{1F308}"]) {
      accepts(ClientMessageSchema, chat(`hi ${ok}`));
    }
    rejects(ClientMessageSchema, chat("a\u200Db"));
    rejects(ClientMessageSchema, chat("\u{1F44D}\u200D"));
    rejects(ClientMessageSchema, chat("x \u200D\u{1F44D}"));
    rejects(ClientMessageSchema, chat("a\u200D\u{1F44D}"));
  });

  test("at most 3 combining marks in a row (no Zalgo)", () => {
    accepts(ClientMessageSchema, chat("x\u0301\u0302\u0303"));
    rejects(ClientMessageSchema, chat("x\u0301\u0302\u0303\u0304"));
  });

  test("bidi and zero-width characters are still rejected", () => {
    for (const c of ["\u200B", "\u2060", "\uFEFF", "\u200E", "\u202E", "\u2067"]) {
      rejects(ClientMessageSchema, chat(`a${c}b`));
    }
  });

  test("chat rejects extra keys", () => {
    rejects(ClientMessageSchema, { type: "chat", text: "hi", color: "red" });
  });
});
