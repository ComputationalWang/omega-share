import * as v from "valibot";
import { ERROR_MESSAGE_MAX_LENGTH } from "./constants";
import type { ClientMessage } from "./messages";
import { RoomIdSchema } from "./room";
import { RetryAfterMsSchema } from "./share";

/**
 * Discord Activity bootstrap, admission and browser handoff (ADR 0046). Admission sits in front
 * of the unchanged room protocol: identity comes from the server's OAuth exchange and instance
 * check, never from a client field.
 */

export const ACTIVITY_BOOTSTRAP_TTL_MS = 60_000;
export const ACTIVITY_TICKET_TTL_MS = 60_000;
/** Hard limit, or OAuth `expires_in` if sooner. Never renewed: expiry means re-authorize. */
export const ACTIVITY_SESSION_MAX_MS = 15 * 60_000;
/** From upgrade to the `admit` frame; the server closes with ADMISSION_FAILED after it. */
export const ACTIVITY_ADMISSION_DEADLINE_MS = 5_000;
/** Longest an admitted socket may live past the last successful instance-membership check. */
export const ACTIVITY_MEMBERSHIP_FRESHNESS_MS = 30_000;
export const HANDOFF_CODE_TTL_MS = 60_000;
/** Hard limit for a standalone handoff grant. Never renewed or extended by OAuth. */
export const HANDOFF_GRANT_MAX_MS = 15 * 60_000;
export const MAX_ADMISSION_FRAME_BYTES = 256;
/** Unconsumed bootstrap nonces held server-wide; past it bootstrap answers `too_many_pending`. */
export const ACTIVITY_MAX_PENDING_BOOTSTRAPS = 1000;
/** Cap on every raw Activity/handoff request body. */
export const MAX_ACTIVITY_BODY_BYTES = 2048;
export const DISCORD_INSTANCE_ID_MAX_LENGTH = 128;
export const DISCORD_OAUTH_CODE_MAX_LENGTH = 128;
export const DISCORD_ACCESS_TOKEN_MAX_LENGTH = 512;

/** Relative to the page origin (the Discord proxy origin inside the Activity). No credential ever goes in a path or query. */
export const ACTIVITY_ROUTES = {
  bootstrap: "/api/discord/bootstrap",
  session: "/api/discord/session",
  ticket: "/api/discord/ticket",
  logout: "/api/discord/logout",
  handoffStart: "/api/discord/handoff",
  handoffConfirm: "/api/discord/handoff/confirm",
  handoffClaim: "/api/handoff/claim",
  handoffRedeem: "/api/handoff/redeem",
  handoffTicket: "/api/handoff/ticket",
} as const;

/** 32 server-random bytes, canonical unpadded base64url (the last char carries 4 bits). The server keeps only hashes. */
const SECRET_BODY = "[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]";
const SECRET = new RegExp(`^${SECRET_BODY}$`);
const secret = <const B extends string>(brand: B) => v.pipe(v.string(), v.regex(SECRET), v.brand(brand));

/** OAuth `state` for SDK `authorize`: single use, bound to the instance it was issued for. */
export const BootstrapNonceSchema = secret("BootstrapNonce");
export type BootstrapNonce = v.InferOutput<typeof BootstrapNonceSchema>;
/** Bearer for Activity routes. Activity memory only. */
export const ActivitySessionTokenSchema = secret("ActivitySessionToken");
export type ActivitySessionToken = v.InferOutput<typeof ActivitySessionTokenSchema>;
/** Single use, bound to room, instance, user and a live session or grant. */
export const AdmissionTicketSchema = secret("AdmissionTicket");
export type AdmissionTicket = v.InferOutput<typeof AdmissionTicketSchema>;
/** Travels only in the `/handoff#h=<code>` fragment and handoff bodies. */
export const HandoffCodeSchema = secret("HandoffCode");
export type HandoffCode = v.InferOutput<typeof HandoffCodeSchema>;
/** Proves the redeemer is the browser that claimed the code. */
export const HandoffReceiverTokenSchema = secret("HandoffReceiverToken");
export type HandoffReceiverToken = v.InferOutput<typeof HandoffReceiverTokenSchema>;
/** Bearer for `/api/handoff/ticket`: one room, one user, no owner rights. */
export const HandoffGrantSchema = secret("HandoffGrant");
export type HandoffGrant = v.InferOutput<typeof HandoffGrantSchema>;

/** Opaque: never parsed for identity, guild or channel. */
export const DiscordInstanceIdSchema = v.pipe(v.string(), v.regex(new RegExp(`^[A-Za-z0-9_-]{1,${String(DISCORD_INSTANCE_ID_MAX_LENGTH)}}$`)));
export const DiscordOAuthCodeSchema = v.pipe(v.string(), v.regex(new RegExp(`^[A-Za-z0-9._~-]{1,${String(DISCORD_OAUTH_CODE_MAX_LENGTH)}}$`)));
export const DiscordAccessTokenSchema = v.pipe(v.string(), v.regex(new RegExp(`^[A-Za-z0-9._~+/=-]{1,${String(DISCORD_ACCESS_TOKEN_MAX_LENGTH)}}$`)));

/** Crockford base32 without I, L, O, U. */
const CONFIRM_CODE = /^[0-9A-HJKMNP-TV-Z]{6}$/;
/** Shown on the standalone page; the Activity user types it. */
export const HandoffConfirmCodeSchema = v.pipe(v.string(), v.regex(CONFIRM_CODE));

const ms = (max: number) => v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(max));
const RoomRefSchema = v.object({ id: RoomIdSchema });

const failure = <const C extends readonly [string, ...string[]]>(codes: C) =>
  v.object({
    ok: v.literal(false),
    error: v.object({
      code: v.picklist(codes),
      message: v.pipe(v.string(), v.maxLength(ERROR_MESSAGE_MAX_LENGTH)),
      /** With `rate_limited`, `discord_unavailable` and `handoff_pending`. */
      retryAfterMs: v.optional(RetryAfterMsSchema),
    }),
  });

const success = <const E extends v.ObjectEntries>(entries: E) => v.object({ ok: v.literal(true), ...entries });

/** Server-derived; the client never asserts a capability. */
export const ActivityCapabilitiesSchema = v.object({ handoff: v.boolean() });
export type ActivityCapabilities = v.InferOutput<typeof ActivityCapabilitiesSchema>;

export const ActivityBootstrapRequestSchema = v.strictObject({ instanceId: DiscordInstanceIdSchema });
export type ActivityBootstrapRequest = v.InferOutput<typeof ActivityBootstrapRequestSchema>;
export const ACTIVITY_BOOTSTRAP_ERROR_CODES = ["invalid_body", "payload_too_large", "rate_limited", "too_many_pending", "activity_disabled"] as const;
export const ActivityBootstrapResponseSchema = v.variant("ok", [
  success({ nonce: BootstrapNonceSchema, expiresInMs: ms(ACTIVITY_BOOTSTRAP_TTL_MS) }),
  failure(ACTIVITY_BOOTSTRAP_ERROR_CODES),
]);
export type ActivityBootstrapResponse = v.InferOutput<typeof ActivityBootstrapResponseSchema>;

/** No user id, room id or token: the server derives all of them. */
export const ActivitySessionRequestSchema = v.strictObject({ nonce: BootstrapNonceSchema, code: DiscordOAuthCodeSchema, instanceId: DiscordInstanceIdSchema });
export type ActivitySessionRequest = v.InferOutput<typeof ActivitySessionRequestSchema>;
export const ACTIVITY_SESSION_ERROR_CODES = [
  "invalid_body",
  "payload_too_large",
  "rate_limited",
  /** Unknown, expired, replayed, or issued for another instance. */
  "nonce_invalid",
  /** Discord refused the code, or the token lacks `identify`. */
  "oauth_failed",
  /** The verified user isn't in the instance's `users`, or app/instance mismatch. */
  "not_in_instance",
  /** Discord says the instance no longer exists. */
  "instance_unavailable",
  /** Discord 429 or outage; carries `retryAfterMs`. */
  "discord_unavailable",
  /** Kill switch, or the OAuth state binding is unproven (ADR 0046). */
  "activity_disabled",
] as const;
export const ActivitySessionResponseSchema = v.variant("ok", [
  success({
    /** For SDK `authenticate` only. Activity memory; never stored or sent elsewhere. */
    accessToken: DiscordAccessTokenSchema,
    session: ActivitySessionTokenSchema,
    sessionExpiresInMs: ms(ACTIVITY_SESSION_MAX_MS),
    room: RoomRefSchema,
    ticket: AdmissionTicketSchema,
    ticketExpiresInMs: ms(ACTIVITY_TICKET_TTL_MS),
    capabilities: ActivityCapabilitiesSchema,
  }),
  failure(ACTIVITY_SESSION_ERROR_CODES),
]);
export type ActivitySessionResponse = v.InferOutput<typeof ActivitySessionResponseSchema>;

const TicketGrantSchema = success({ ticket: AdmissionTicketSchema, ticketExpiresInMs: ms(ACTIVITY_TICKET_TTL_MS) });

/**
 * `POST /api/discord/ticket`, bearer session, empty body. Needs a membership check no older than
 * ACTIVITY_MEMBERSHIP_FRESHNESS_MS. `handed_off`: this session confirmed a handoff and is spent.
 */
export const ACTIVITY_TICKET_ERROR_CODES = [
  "invalid_body",
  "unauthorized",
  "handed_off",
  "not_in_instance",
  "instance_unavailable",
  "discord_unavailable",
  "rate_limited",
  "activity_disabled",
] as const;
export const ActivityTicketResponseSchema = v.variant("ok", [TicketGrantSchema, failure(ACTIVITY_TICKET_ERROR_CODES)]);
export type ActivityTicketResponse = v.InferOutput<typeof ActivityTicketResponseSchema>;

/** `POST /api/handoff/ticket`, bearer grant, empty body. Delegated authority: no Discord membership check. */
export const HANDOFF_TICKET_ERROR_CODES = ["invalid_body", "unauthorized", "rate_limited", "activity_disabled"] as const;
export const HandoffTicketResponseSchema = v.variant("ok", [TicketGrantSchema, failure(HANDOFF_TICKET_ERROR_CODES)]);
export type HandoffTicketResponse = v.InferOutput<typeof HandoffTicketResponseSchema>;

/** Empty body. One pending handoff per session: a new start supersedes the previous code. */
export const HANDOFF_START_ERROR_CODES = ["invalid_body", "unauthorized", "handed_off", "rate_limited", "handoff_unsupported", "activity_disabled"] as const;
export const HandoffStartResponseSchema = v.variant("ok", [success({ code: HandoffCodeSchema, expiresInMs: ms(HANDOFF_CODE_TTL_MS) }), failure(HANDOFF_START_ERROR_CODES)]);
export type HandoffStartResponse = v.InferOutput<typeof HandoffStartResponseSchema>;

const HANDOFF_HASH = new RegExp(`^#h=(${SECRET_BODY})$`);
/** The code in a `location.hash` of exactly `#h=<code>`, else null. Never throws. */
export function handoffCodeFromHash(hash: string): HandoffCode | null {
  if (hash.length !== 3 + 43) return null;
  const raw = HANDOFF_HASH.exec(hash)?.[1];
  if (raw === undefined) return null;
  const parsed = v.safeParse(HandoffCodeSchema, raw);
  return parsed.success ? parsed.output : null;
}

export const HandoffClaimRequestSchema = v.strictObject({ code: HandoffCodeSchema });
export type HandoffClaimRequest = v.InferOutput<typeof HandoffClaimRequestSchema>;
/** `handoff_invalid`: unknown, expired, superseded or cancelled. `handoff_claimed`: another browser claimed it first. */
export const HANDOFF_CLAIM_ERROR_CODES = ["invalid_body", "payload_too_large", "rate_limited", "handoff_invalid", "handoff_claimed"] as const;
export const HandoffClaimResponseSchema = v.variant("ok", [
  success({ receiver: HandoffReceiverTokenSchema, confirmCode: HandoffConfirmCodeSchema, expiresInMs: ms(HANDOFF_CODE_TTL_MS) }),
  failure(HANDOFF_CLAIM_ERROR_CODES),
]);
export type HandoffClaimResponse = v.InferOutput<typeof HandoffClaimResponseSchema>;

/**
 * Typed by a person: trimmed and upper-cased first. A well-formed wrong code cancels the transfer;
 * a malformed body (`invalid_body`) does not.
 */
export const HandoffConfirmRequestSchema = v.strictObject({
  confirmCode: v.pipe(v.string(), v.maxLength(16), v.trim(), v.toUpperCase(), v.regex(CONFIRM_CODE)),
});
export type HandoffConfirmRequest = v.InferOutput<typeof HandoffConfirmRequestSchema>;
/** `handed_off`: this session already confirmed a handoff. */
export const HANDOFF_CONFIRM_ERROR_CODES = ["invalid_body", "payload_too_large", "unauthorized", "handed_off", "handoff_invalid", "rate_limited"] as const;
export const HandoffConfirmResponseSchema = v.variant("ok", [success({}), failure(HANDOFF_CONFIRM_ERROR_CODES)]);
export type HandoffConfirmResponse = v.InferOutput<typeof HandoffConfirmResponseSchema>;

export const HandoffRedeemRequestSchema = v.strictObject({ code: HandoffCodeSchema, receiver: HandoffReceiverTokenSchema });
export type HandoffRedeemRequest = v.InferOutput<typeof HandoffRedeemRequestSchema>;
/**
 * `handoff_pending`: not confirmed yet, retry after `retryAfterMs`. Retry-safe: repeating it with the
 * same code and receiver within HANDOFF_CODE_TTL_MS of confirm rotates the grant (the previous one is revoked).
 */
export const HANDOFF_REDEEM_ERROR_CODES = ["invalid_body", "payload_too_large", "rate_limited", "handoff_pending", "handoff_invalid"] as const;
export const HandoffRedeemResponseSchema = v.variant("ok", [
  success({
    room: RoomRefSchema,
    grant: HandoffGrantSchema,
    grantExpiresInMs: ms(HANDOFF_GRANT_MAX_MS),
    ticket: AdmissionTicketSchema,
    ticketExpiresInMs: ms(ACTIVITY_TICKET_TTL_MS),
  }),
  failure(HANDOFF_REDEEM_ERROR_CODES),
]);
export type HandoffRedeemResponse = v.InferOutput<typeof HandoffRedeemResponseSchema>;

/** The one frame an Activity-room socket may send before admission. Not part of the room union. */
export const AdmissionFrameSchema = v.strictObject({ type: v.literal("admit"), ticket: AdmissionTicketSchema });
export type AdmissionFrame = v.InferOutput<typeof AdmissionFrameSchema>;

/** Boundary parser for the first frame on an Activity-room socket. Never throws. */
export function parseAdmissionFrame(raw: string): AdmissionFrame | null {
  // Every valid frame is ASCII, so UTF-16 length bounds the bytes.
  if (raw.length > MAX_ADMISSION_FRAME_BYTES) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = v.safeParse(AdmissionFrameSchema, json);
  return result.success ? result.output : null;
}

const ACTIVITY_JOIN_KEYS: ReadonlySet<string> = new Set(["type", "nickname", "avatar"]);

/** An admitted socket's `join`: nickname and avatar only. An allowlist, so a future authority field stays out. */
export function isActivityJoin(message: ClientMessage): boolean {
  if (message.type !== "join") return false;
  for (const key in message) if (!ACTIVITY_JOIN_KEYS.has(key)) return false;
  return true;
}
