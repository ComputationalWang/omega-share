import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ACTIVITY_ADMISSION_DEADLINE_MS,
  ACTIVITY_BOOTSTRAP_TTL_MS,
  ACTIVITY_MEMBERSHIP_FRESHNESS_MS,
  ACTIVITY_ROUTES,
  ACTIVITY_SESSION_MAX_MS,
  ACTIVITY_TICKET_TTL_MS,
  ActivityBootstrapRequestSchema,
  ActivityBootstrapResponseSchema,
  ActivitySessionRequestSchema,
  ActivitySessionResponseSchema,
  ActivityTicketResponseSchema,
  AdmissionTicketSchema,
  ActivitySessionTokenSchema,
  CLOSE_CODES,
  HANDOFF_CODE_TTL_MS,
  HANDOFF_GRANT_MAX_MS,
  HandoffClaimRequestSchema,
  HandoffClaimResponseSchema,
  HandoffConfirmRequestSchema,
  HandoffConfirmResponseSchema,
  HandoffRedeemRequestSchema,
  HandoffRedeemResponseSchema,
  HandoffStartResponseSchema,
  MAX_ACTIVITY_BODY_BYTES,
  MAX_ADMISSION_FRAME_BYTES,
  handoffCodeFromHash,
  isActivityJoin,
  parseAdmissionFrame,
  parseClientMessage,
  type AdmissionTicket,
  type ActivitySessionToken,
  type ClientMessage,
} from "../src";

const secret = (c: string) => "Ab_-" + c.repeat(39);
const nonce = secret("n");
const ticket = secret("t");
const session = secret("s");
const code = secret("h");
const receiver = secret("r");
const instanceId = "i-1288744420012345678-gc-123456789012345678-987654321098765432";
const oauthCode = "AbCdEf0123456789xyzXYZ01234567";

test("deadlines match the reviewed R1 proposal", () => {
  expect(ACTIVITY_BOOTSTRAP_TTL_MS).toBe(60_000);
  expect(ACTIVITY_TICKET_TTL_MS).toBe(60_000);
  expect(ACTIVITY_SESSION_MAX_MS).toBe(15 * 60_000);
  expect(ACTIVITY_ADMISSION_DEADLINE_MS).toBe(5_000);
  expect(ACTIVITY_MEMBERSHIP_FRESHNESS_MS).toBe(30_000);
  expect(HANDOFF_CODE_TTL_MS).toBe(60_000);
  expect(HANDOFF_GRANT_MAX_MS).toBe(15 * 60_000);
  expect(MAX_ADMISSION_FRAME_BYTES).toBe(256);
  expect(MAX_ACTIVITY_BODY_BYTES).toBe(2048);
});

test("close codes for admission, revocation and handoff are new and distinct", () => {
  expect(CLOSE_CODES.ADMISSION_FAILED).toBe(4401);
  expect(CLOSE_CODES.SESSION_REVOKED).toBe(4403);
  expect(CLOSE_CODES.HANDED_OFF).toBe(4008);
  const all = Object.values(CLOSE_CODES);
  expect(new Set(all).size).toBe(all.length);
});

test("routes are fixed, relative and never carry a credential", () => {
  for (const path of Object.values(ACTIVITY_ROUTES)) {
    expect(path).toMatch(/^\/api\/(discord|handoff)\/[a-z/]+$/);
  }
  expect(ACTIVITY_ROUTES.handoffClaim.startsWith("/api/handoff/")).toBe(true);
  expect(ACTIVITY_ROUTES.session.startsWith("/api/discord/")).toBe(true);
});

test("bootstrap takes only an opaque bounded instance id; the response is a single-use nonce", () => {
  expect(v.parse(ActivityBootstrapRequestSchema, { instanceId }) as unknown).toEqual({ instanceId });
  for (const bad of [
    {},
    { instanceId: "" },
    { instanceId: "x".repeat(129) },
    { instanceId: "../rooms" },
    { instanceId: "i 1" },
    { instanceId, userId: "123456789012345678" },
    { instanceId, roomId: "lobby" },
  ]) {
    expect(v.safeParse(ActivityBootstrapRequestSchema, bad).success).toBe(false);
  }
  const ok = { ok: true, nonce, expiresInMs: 60_000 };
  expect(v.parse(ActivityBootstrapResponseSchema, ok) as unknown).toEqual(ok);
  for (const bad of [{ ...ok, expiresInMs: 60_001 }, { ...ok, expiresInMs: 0 }, { ...ok, nonce: "short" }]) {
    expect(v.safeParse(ActivityBootstrapResponseSchema, bad).success).toBe(false);
  }
  for (const c of ["invalid_body", "payload_too_large", "rate_limited", "too_many_pending", "activity_disabled"]) {
    expect(v.safeParse(ActivityBootstrapResponseSchema, { ok: false, error: { code: c, message: "no" } }).success).toBe(true);
  }
  expect(v.safeParse(ActivityBootstrapResponseSchema, { ok: false, error: { code: "not_in_instance", message: "no" } }).success).toBe(false);
});

test("the session exchange carries no client-supplied identity, room or token", () => {
  const body = { nonce, code: oauthCode, instanceId };
  expect(v.parse(ActivitySessionRequestSchema, body) as unknown).toEqual(body);
  for (const extra of [
    { userId: "123456789012345678" },
    { roomId: "lobby" },
    { accessToken: "abc" },
    { nickname: "Alice" },
    { applicationId: "123456789012345678" },
  ]) {
    expect(v.safeParse(ActivitySessionRequestSchema, { ...body, ...extra }).success).toBe(false);
  }
  for (const bad of [{ ...body, code: "" }, { ...body, code: "x".repeat(129) }, { ...body, code: "a b" }, { ...body, nonce: ticket.slice(1) }]) {
    expect(v.safeParse(ActivitySessionRequestSchema, bad).success).toBe(false);
  }
});

test("a session grant is bounded, room-bound and server-derived", () => {
  const ok = {
    ok: true,
    accessToken: "dGhpcyBpcyBub3QgYSByZWFsIHRva2Vu.abc-_~",
    session,
    sessionExpiresInMs: ACTIVITY_SESSION_MAX_MS,
    room: { id: "a7k2m9q4x1" },
    ticket,
    ticketExpiresInMs: ACTIVITY_TICKET_TTL_MS,
    capabilities: { handoff: false },
  };
  expect(v.parse(ActivitySessionResponseSchema, ok) as unknown).toEqual(ok);
  for (const bad of [
    { ...ok, sessionExpiresInMs: ACTIVITY_SESSION_MAX_MS + 1 },
    { ...ok, ticketExpiresInMs: ACTIVITY_TICKET_TTL_MS + 1 },
    { ...ok, ticket: "short" },
    { ...ok, room: { id: "../x" } },
    { ...ok, accessToken: "" },
    { ...ok, accessToken: "x".repeat(513) },
    { ...ok, capabilities: { handoff: "yes" } },
  ]) {
    expect(v.safeParse(ActivitySessionResponseSchema, bad).success).toBe(false);
  }
  for (const c of [
    "invalid_body",
    "payload_too_large",
    "rate_limited",
    "nonce_invalid",
    "oauth_failed",
    "not_in_instance",
    "instance_unavailable",
    "discord_unavailable",
    "activity_disabled",
  ]) {
    expect(v.safeParse(ActivitySessionResponseSchema, { ok: false, error: { code: c, message: "no", retryAfterMs: 1000 } }).success).toBe(true);
  }
});

test("reconnect tickets need a session and re-check membership", () => {
  const ok = { ok: true, ticket, ticketExpiresInMs: 60_000 };
  expect(v.parse(ActivityTicketResponseSchema, ok) as unknown).toEqual(ok);
  for (const c of ["unauthorized", "not_in_instance", "instance_unavailable", "discord_unavailable", "rate_limited", "activity_disabled"]) {
    expect(v.safeParse(ActivityTicketResponseSchema, { ok: false, error: { code: c, message: "no" } }).success).toBe(true);
  }
  expect(v.safeParse(ActivityTicketResponseSchema, { ...ok, ticketExpiresInMs: 60_001 }).success).toBe(false);
});

test("tickets and sessions are distinct branded credentials", () => {
  const t: AdmissionTicket = v.parse(AdmissionTicketSchema, ticket);
  const s: ActivitySessionToken = v.parse(ActivitySessionTokenSchema, session);
  // @ts-expect-error a session token is not an admission ticket
  const wrong: AdmissionTicket = s;
  expect([t, wrong] as unknown).toEqual([ticket, session]);
  for (const bad of [ticket + "=", ticket.slice(1), ticket.slice(1) + "/", ticket.slice(1) + "+", null, 43]) {
    expect(v.safeParse(AdmissionTicketSchema, bad).success).toBe(false);
  }
});

test("the admission frame is exactly one bounded ticket, separate from the room protocol", () => {
  expect(parseAdmissionFrame(JSON.stringify({ type: "admit", ticket })) as unknown).toEqual({ type: "admit", ticket });
  for (const raw of [
    JSON.stringify({ type: "admit", ticket, roomId: "lobby" }),
    JSON.stringify({ type: "admit", ticket, userId: "123456789012345678" }),
    JSON.stringify({ type: "admit" }),
    JSON.stringify({ type: "admit", ticket: session.slice(2) }),
    JSON.stringify({ type: "join", nickname: "Alice", avatar: 0 }),
    JSON.stringify({ type: "ping", id: 1 }),
    JSON.stringify({ type: "admit", ticket }) + " ".repeat(MAX_ADMISSION_FRAME_BYTES),
    "not json",
    "",
  ]) {
    expect(parseAdmissionFrame(raw)).toBeNull();
  }
  // The anonymous room union is unchanged: it never admits.
  expect(parseClientMessage(JSON.stringify({ type: "admit", ticket }))).toBeNull();
});

test("an admitted join carries no standalone authority", () => {
  const join = (extra: object): ClientMessage => {
    const m = parseClientMessage(JSON.stringify({ type: "join", nickname: "Alice", avatar: 0, ...extra }));
    if (m === null) throw new Error("fixture must parse");
    return m;
  };
  expect(isActivityJoin(join({}))).toBe(true);
  for (const extra of [{ ownerToken: secret("o").slice(0, 22) }, { inviteKey: secret("i").slice(0, 22) }, { resumeToken: secret("x") }, { durableSession: true }]) {
    expect(isActivityJoin(join(extra))).toBe(false);
  }
  const leave = parseClientMessage(JSON.stringify({ type: "leave" }));
  if (leave === null) throw new Error("fixture must parse");
  expect(isActivityJoin(leave)).toBe(false);
});

test("handoff start returns a short-lived code read only from an exact fragment", () => {
  const ok = { ok: true, code, expiresInMs: HANDOFF_CODE_TTL_MS };
  expect(v.parse(HandoffStartResponseSchema, ok) as unknown).toEqual(ok);
  expect(v.safeParse(HandoffStartResponseSchema, { ...ok, expiresInMs: HANDOFF_CODE_TTL_MS + 1 }).success).toBe(false);
  for (const c of ["unauthorized", "rate_limited", "handoff_unsupported", "activity_disabled"]) {
    expect(v.safeParse(HandoffStartResponseSchema, { ok: false, error: { code: c, message: "no" } }).success).toBe(true);
  }
  expect(handoffCodeFromHash(`#h=${code}`) as unknown).toBe(code);
  for (const hash of ["", `#h=${code}x`, `#h=${code.slice(1)}`, `#k=${code}`, `h=${code}`, `#h=${code}&k=1`, `#h=${code.slice(1)}=`]) {
    expect(handoffCodeFromHash(hash)).toBeNull();
  }
});

test("handoff claim binds one receiver and shows a confirm code the Activity user must enter", () => {
  expect(v.parse(HandoffClaimRequestSchema, { code }) as unknown).toEqual({ code });
  expect(v.safeParse(HandoffClaimRequestSchema, { code, roomId: "lobby" }).success).toBe(false);
  const ok = { ok: true, receiver, confirmCode: "7K3QZP", expiresInMs: HANDOFF_CODE_TTL_MS };
  expect(v.parse(HandoffClaimResponseSchema, ok) as unknown).toEqual(ok);
  for (const bad of [{ ...ok, confirmCode: "7K3QZ" }, { ...ok, confirmCode: "7K3QZI" }, { ...ok, confirmCode: "7k3qzp" }, { ...ok, receiver: "short" }]) {
    expect(v.safeParse(HandoffClaimResponseSchema, bad).success).toBe(false);
  }
  expect(v.safeParse(HandoffClaimResponseSchema, { ok: false, error: { code: "handoff_invalid", message: "no" } }).success).toBe(true);

  // Typed by a person: trimmed and upper-cased before the alphabet check.
  expect(v.parse(HandoffConfirmRequestSchema, { confirmCode: " 7k3qzp " }) as unknown).toEqual({ confirmCode: "7K3QZP" });
  for (const bad of [{ confirmCode: "7K3QZO" }, { confirmCode: "" }, { confirmCode: "7K3QZP", code }]) {
    expect(v.safeParse(HandoffConfirmRequestSchema, bad).success).toBe(false);
  }
  expect(v.parse(HandoffConfirmResponseSchema, { ok: true }) as unknown).toEqual({ ok: true });
  for (const c of ["unauthorized", "handoff_invalid", "rate_limited"]) {
    expect(v.safeParse(HandoffConfirmResponseSchema, { ok: false, error: { code: c, message: "no" } }).success).toBe(true);
  }
});

test("handoff redeem needs the code and the receiver, and yields a bounded least-privilege grant", () => {
  const body = { code, receiver };
  expect(v.parse(HandoffRedeemRequestSchema, body) as unknown).toEqual(body);
  for (const bad of [{ code }, { receiver }, { ...body, owner: true }, { ...body, roomId: "lobby" }]) {
    expect(v.safeParse(HandoffRedeemRequestSchema, bad).success).toBe(false);
  }
  const ok = { ok: true, room: { id: "a7k2m9q4x1" }, grant: secret("g"), grantExpiresInMs: HANDOFF_GRANT_MAX_MS, ticket, ticketExpiresInMs: ACTIVITY_TICKET_TTL_MS };
  expect(v.parse(HandoffRedeemResponseSchema, ok) as unknown).toEqual(ok);
  for (const bad of [{ ...ok, grantExpiresInMs: HANDOFF_GRANT_MAX_MS + 1 }, { ...ok, grant: "short" }]) {
    expect(v.safeParse(HandoffRedeemResponseSchema, bad).success).toBe(false);
  }
  // No ownership or Discord credential can ride along: unknown keys are stripped, never trusted.
  const parsed = v.parse(HandoffRedeemResponseSchema, { ...ok, ownerToken: "x", accessToken: "y" });
  expect(Object.keys(parsed).sort()).toEqual(Object.keys(ok).sort());
  expect(v.safeParse(HandoffRedeemResponseSchema, { ok: false, error: { code: "handoff_pending", message: "wait", retryAfterMs: 1000 } }).success).toBe(true);
  expect(v.safeParse(HandoffRedeemResponseSchema, { ok: false, error: { code: "handoff_invalid", message: "no" } }).success).toBe(true);
});
