import * as v from "valibot";
import { ERROR_MESSAGE_MAX_LENGTH, REPORT_KEY_REFILL_MS, REPORT_NOTE_MAX_LENGTH } from "./constants";
import { plainTextSchema } from "./messages";

/**
 * Abuse reports (ADR 0033): `POST /rooms/:id/report`, no token or seat needed. The report goes to
 * the operators only, never to the room, its owner or other reporters.
 */

/** Matches the set (k) dialog: sexual content, violence or gore, hate or harassment, spam or scams, someone may be in danger, something else. */
export const REPORT_REASONS = ["sexual", "violence", "hate", "spam", "danger", "other"] as const;
export const ReportReasonSchema = v.picklist(REPORT_REASONS);
export type ReportReason = v.InferOutput<typeof ReportReasonSchema>;

/** Line breaks in a pasted note may grow it before they collapse; anything longer than this is refused unread. */
const REPORT_NOTE_RAW_MAX_LENGTH = 2 * REPORT_NOTE_MAX_LENGTH;

/**
 * Optional free text. Bounded before any regex runs, line breaks and tabs become one space, then
 * chat's rules at 1–300 chars. The site omits a blank note. The server redacts it before storing (ADR 0033 §3).
 */
export const ReportNoteSchema = v.pipe(
  v.string(),
  v.maxLength(REPORT_NOTE_RAW_MAX_LENGTH),
  v.transform((s) => s.replace(/[\r\n\t]+/g, " ")),
  plainTextSchema(REPORT_NOTE_MAX_LENGTH),
);
export type ReportNote = v.InferOutput<typeof ReportNoteSchema>;

/** Body of `POST /rooms/:id/report`, at most `MAX_REPORT_BODY_BYTES`. Strict: nothing about the reporter fits in it. */
export const ReportRequestSchema = v.strictObject({ reason: ReportReasonSchema, note: v.optional(ReportNoteSchema) });
export type ReportRequest = v.InferOutput<typeof ReportRequestSchema>;

/** `received`: stored (HTTP 202). `already_reported`: this client key already reported this room; nothing new is stored (HTTP 200). */
export const REPORT_STATUSES = ["received", "already_reported"] as const;

export const REPORT_ERROR_CODES = [
  "invalid_body",
  /** HTTP 413. */
  "payload_too_large",
  /** HTTP 404: no such room, or it was taken down. */
  "room_not_found",
  /** HTTP 429 with `Retry-After`: the client key's or the room's report bucket is empty. */
  "rate_limited",
  /** HTTP 503: REPORT_MAX_OPEN reached, or the store failed. Nothing was stored. */
  "unavailable",
] as const;
export type ReportErrorCode = (typeof REPORT_ERROR_CODES)[number];

/** Answer to `POST /rooms/:id/report`. Never carries a report id or anything about other reports. */
export const ReportResponseSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), status: v.picklist(REPORT_STATUSES) }),
  v.object({
    ok: v.literal(false),
    error: v.object({
      code: v.picklist(REPORT_ERROR_CODES),
      message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
      /** With `rate_limited`; may wait out the key bucket's full refill. */
      retryAfterMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(REPORT_KEY_REFILL_MS))),
    }),
  }),
]);
export type ReportResponse = v.InferOutput<typeof ReportResponseSchema>;
