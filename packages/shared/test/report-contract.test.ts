import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  CLOSE_CODES,
  MAX_REPORT_BODY_BYTES,
  REPORT_ERROR_CODES,
  REPORT_KEY_BURST,
  REPORT_KEY_REFILL_MS,
  REPORT_MAX_OPEN,
  REPORT_NOTE_MAX_LENGTH,
  REPORT_REASONS,
  REPORT_RETENTION_MS,
  REPORT_ROOM_BURST,
  REPORT_ROOM_REFILL_MS,
  ReportNoteSchema,
  ReportRequestSchema,
  ReportResponseSchema,
  type ReportRequest,
} from "../src/index";

// Abuse reports (OME-592, M7 C1, ADR 0033): `POST /rooms/:id/report`.

function rejects(schema: v.GenericSchema, input: unknown): void {
  expect(v.safeParse(schema, input).success).toBe(false);
}

describe("ReportRequestSchema", () => {
  test("accepts every reason, with and without a note", () => {
    for (const reason of REPORT_REASONS) {
      expect(v.parse(ReportRequestSchema, { reason })).toEqual({ reason });
      expect(v.parse(ReportRequestSchema, { reason, note: "the chat posts slurs" })).toEqual({ reason, note: "the chat posts slurs" });
    }
  });

  test("the reasons match the set (k) report dialog", () => {
    expect(REPORT_REASONS).toEqual(["sexual", "violence", "hate", "spam", "danger", "other"]);
  });

  test("rejects an unknown, missing or non-string reason", () => {
    rejects(ReportRequestSchema, { reason: "illegal" });
    rejects(ReportRequestSchema, { reason: "SPAM" });
    rejects(ReportRequestSchema, {});
    rejects(ReportRequestSchema, { reason: 1 });
    rejects(ReportRequestSchema, { note: "no reason" });
  });

  test("rejects extra keys: the room id is in the path, and nothing about the reporter is accepted", () => {
    rejects(ReportRequestSchema, { reason: "spam", roomId: "lobby" });
    rejects(ReportRequestSchema, { reason: "spam", email: "a@b.example" });
    rejects(ReportRequestSchema, { reason: "spam", nickname: "ann" });
    rejects(ReportRequestSchema, { reason: "spam", note: "x", __proto__x: 1 });
  });

  test("rejects a non-object body", () => {
    for (const body of [null, "spam", ["spam"], 3]) rejects(ReportRequestSchema, body);
  });

  test("the largest valid body fits MAX_REPORT_BODY_BYTES, even when every character needs JSON escaping", () => {
    const longestReason = REPORT_REASONS.reduce((a, b) => (b.length > a.length ? b : a));
    for (const ch of ['"', "\\", "€", "😀"]) {
      const note = ch.repeat(Math.floor(REPORT_NOTE_MAX_LENGTH / ch.length));
      const body: ReportRequest = v.parse(ReportRequestSchema, { reason: longestReason, note });
      expect(new TextEncoder().encode(JSON.stringify(body)).length).toBeLessThanOrEqual(MAX_REPORT_BODY_BYTES);
    }
  });
});

describe("ReportNoteSchema", () => {
  test("trims, NFC-normalizes and turns line breaks and tabs into single spaces", () => {
    expect(v.parse(ReportNoteSchema, "  hi  ")).toBe("hi");
    expect(v.parse(ReportNoteSchema, "e\u0301")).toBe("\u00E9");
    expect(v.parse(ReportNoteSchema, "line one\r\n\r\nline\ttwo")).toBe("line one line two");
  });

  test(`accepts exactly ${String(REPORT_NOTE_MAX_LENGTH)} characters, rejects one more`, () => {
    expect(v.parse(ReportNoteSchema, "a".repeat(REPORT_NOTE_MAX_LENGTH))).toHaveLength(REPORT_NOTE_MAX_LENGTH);
    rejects(ReportNoteSchema, "a".repeat(REPORT_NOTE_MAX_LENGTH + 1));
  });

  test("rejects an oversized note before any regex runs over it", () => {
    const huge = "a\n".repeat(1_000_000);
    const started = performance.now();
    rejects(ReportNoteSchema, huge);
    expect(performance.now() - started).toBeLessThan(50);
  });

  test("an oversized note fails the whole request", () => {
    rejects(ReportRequestSchema, { reason: "other", note: "a".repeat(REPORT_NOTE_MAX_LENGTH + 1) });
  });

  test("rejects empty, blank and invisible notes (the site omits a blank note)", () => {
    for (const note of ["", "   ", "\n\t", "\u200B", "\u3164", "\u0301\u0301"]) rejects(ReportNoteSchema, note);
  });

  test("rejects control, format and bidi characters like chat does", () => {
    for (const note of ["a\u0000b", "a\u202Eb", "a\uFEFFb", "a\u200Bb", "a\u0007b"]) rejects(ReportNoteSchema, note);
  });

  test("rejects a combining-mark stack", () => {
    rejects(ReportNoteSchema, `q${"\u0301".repeat(4)}`);
  });

  test("rejects non-strings", () => {
    for (const note of [null, 1, ["a"], { text: "a" }]) rejects(ReportNoteSchema, note);
  });
});

describe("ReportResponseSchema", () => {
  test("accepts received and already_reported", () => {
    expect(v.parse(ReportResponseSchema, { ok: true, status: "received" })).toEqual({ ok: true, status: "received" });
    expect(v.parse(ReportResponseSchema, { ok: true, status: "already_reported" })).toEqual({ ok: true, status: "already_reported" });
    rejects(ReportResponseSchema, { ok: true, status: "queued" });
    rejects(ReportResponseSchema, { ok: true });
  });

  test("never echoes a report id or anything about other reports", () => {
    expect(v.parse(ReportResponseSchema, { ok: true, status: "received", id: "r1", count: 3 })).toEqual({ ok: true, status: "received" });
  });

  test("accepts every error code; rate_limited carries retryAfterMs up to the key bucket's refill", () => {
    for (const code of REPORT_ERROR_CODES) {
      expect(v.safeParse(ReportResponseSchema, { ok: false, error: { code, message: "no" } }).success).toBe(true);
    }
    expect(v.safeParse(ReportResponseSchema, { ok: false, error: { code: "rate_limited", message: "slow down", retryAfterMs: REPORT_KEY_REFILL_MS } }).success).toBe(true);
    rejects(ReportResponseSchema, { ok: false, error: { code: "rate_limited", message: "slow down", retryAfterMs: REPORT_KEY_REFILL_MS + 1 } });
    rejects(ReportResponseSchema, { ok: false, error: { code: "rate_limited", message: "slow down", retryAfterMs: -1 } });
  });

  test("rejects unknown error codes and oversized messages", () => {
    rejects(ReportResponseSchema, { ok: false, error: { code: "teapot", message: "no" } });
    rejects(ReportResponseSchema, { ok: false, error: { code: "invalid_body", message: "x".repeat(201) } });
  });

  test("the error codes", () => {
    expect([...REPORT_ERROR_CODES]).toEqual(["invalid_body", "payload_too_large", "room_not_found", "rate_limited", "unavailable"]);
  });
});

describe("report limits and takedown close code", () => {
  test("limit values", () => {
    expect(REPORT_NOTE_MAX_LENGTH).toBe(300);
    expect(MAX_REPORT_BODY_BYTES).toBe(2048);
    expect(REPORT_KEY_BURST).toBe(3);
    expect(REPORT_KEY_REFILL_MS).toBe(10 * 60_000);
    expect(REPORT_ROOM_BURST).toBe(20);
    expect(REPORT_ROOM_REFILL_MS).toBe(60_000);
    expect(REPORT_MAX_OPEN).toBe(1000);
    expect(REPORT_RETENTION_MS).toBe(30 * 24 * 60 * 60_000);
  });

  test("TAKEN_DOWN is the next free close code and differs from ROOM_CLOSED", () => {
    expect(CLOSE_CODES.TAKEN_DOWN).toBe(4006);
    const codes = Object.values(CLOSE_CODES);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
