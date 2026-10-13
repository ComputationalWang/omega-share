# 0046 — Discord Activity bootstrap, admission and handoff contract

Status: accepted (contract C0, [OME-967](/OME/issues/OME-967)). Builds on the R1 research proposal ([OME-963](/OME/issues/OME-963#document-adr-proposal)) for M11 ([OME-962](/OME/issues/OME-962)). Consumers: P0 ([OME-965](/OME/issues/OME-965)). Later provider capability refinements follow Q0 ([OME-966](/OME/issues/OME-966)).

## Context

M11 runs omega-share inside Discord as an Activity. An Activity room is private to one Discord activity instance. Membership must come from Discord and be checked by our server; the browser can't be trusted to say who it is. The anonymous room protocol (ADR 0016, 0028, 0043) has no identity at all: `join` carries a nickname, and authority comes from owner, invite and resume bearer tokens. Putting Discord identity fields on `join` would make the client the identity authority, so this ADR adds a separate admission step in front of the unchanged room protocol.

## Decision

### Wire contract (`@omega/shared/activity`)

The contract is a subpath export, kept out of the `@omega/shared` barrel, so the standalone landing and room bundles don't grow. Only the Activity entry and the `/handoff` page import it. A bundle test pins this. All credentials are 32 server-random bytes as canonical unpadded base64url (43 chars, last char one of the 16 that encode 4 bits). Each type is branded (`BootstrapNonce`, `ActivitySessionToken`, `AdmissionTicket`, `HandoffCode`, `HandoffReceiverToken`, `HandoffGrant`), so the compiler won't let one stand in for another. None ever goes in a URL query, a log, `localStorage` or a broadcast. The server stores only hashes.

| Step | Route (`ACTIVITY_ROUTES`) | Request | Success |
|---|---|---|---|
| Bootstrap | `POST /api/discord/bootstrap` | `{ instanceId }` | `{ nonce, expiresInMs ≤ 60 s }` |
| Exchange | `POST /api/discord/session` | `{ nonce, code, instanceId }` | `{ accessToken, session, sessionExpiresInMs ≤ 15 min, room: { id }, ticket, ticketExpiresInMs ≤ 60 s, capabilities }` |
| Reconnect | `POST /api/discord/ticket`, `Authorization: Bearer <session>` | empty | `{ ticket, ticketExpiresInMs }`; `handed_off` once the session confirmed a handoff |
| Logout | `POST /api/discord/logout`, bearer session | empty | `{ ok: true }`, always (no oracle) |
| Handoff start | `POST /api/discord/handoff`, bearer session | empty | `{ code, expiresInMs ≤ 60 s }` |
| Handoff claim | `POST /api/handoff/claim` (standalone) | `{ code }` | `{ receiver, confirmCode, expiresInMs }` |
| Handoff confirm | `POST /api/discord/handoff/confirm`, bearer session | `{ confirmCode }` | `{ ok: true }` |
| Handoff redeem | `POST /api/handoff/redeem` (standalone) | `{ code, receiver }` | `{ room, grant, grantExpiresInMs ≤ 15 min, ticket, ticketExpiresInMs }` |
| Handoff reconnect | `POST /api/handoff/ticket`, `Authorization: Bearer <grant>` | empty | `{ ticket, ticketExpiresInMs }` (separate schema: no membership outcomes) |

Request bodies are strict objects capped at `MAX_ACTIVITY_BODY_BYTES` (2 KiB). An "empty" route rejects any non-empty body with `invalid_body`. Bootstrap is unauthenticated and the instance id is attacker-chosen, so pending nonces have a server-wide cap, `ACTIVITY_MAX_PENDING_BOOTSTRAPS` (1000), as well as a per-ingress bucket. Past the cap, bootstrap answers `too_many_pending` and never evicts a live nonce. No request carries a user id, room id, nickname or Discord token. The server derives identity from the OAuth exchange and the room from `(applicationId, instanceId)`. Responses are non-strict, so the server can add fields and a client never trusts unknown ones. Every error is `{ ok: false, error: { code, message, retryAfterMs? } }` with a per-route code list. Auth responses are `Cache-Control: no-store`.

Bootstrap → exchange: the nonce is the OAuth `state` for the SDK's `authorize`. It is single-use, bound to the instance id it was issued for, and expires after `ACTIVITY_BOOTSTRAP_TTL_MS`. The OAuth code is used once. If P0 can't prove the SDK round-trips `state` to bind the exchange to the initiating browser, exchange stays disabled (`activity_disabled`). That is a release blocker, not a soft unknown. The access token is returned only so the Activity can call SDK `authenticate`. It lives in Activity memory only. The server discards the Discord refresh token; when the session expires, the user re-authorizes.

### Admission (`parseAdmissionFrame`, `isActivityJoin`)

Every socket to an Activity room, whichever route it came in on, must send exactly one admission frame first: `{ "type": "admit", "ticket": "<43>" }`, at most `MAX_ADMISSION_FRAME_BYTES` (256). The server parses it with `parseAdmissionFrame`, not the room union, and must receive it within `ACTIVITY_ADMISSION_DEADLINE_MS` (5 s). It consumes the ticket atomically: the ticket must be unexpired, unused, unrevoked, and bound to this room, this instance and a live session or grant. Before admission the server answers no other frame, subscribes the socket to nothing and sends no snapshot. A missing, late, malformed, forged, replayed, expired, cross-room or cross-instance ticket closes the socket with `CLOSE_CODES.ADMISSION_FAILED` (4401). The client gets a fresh ticket once, then stops.

After admission the socket speaks the ordinary room protocol, starting with `join`. An admitted `join` must satisfy `isActivityJoin`, else `bad_message`. It's an allowlist of present keys (`type`, `nickname`, `avatar`; a parsed frame never carries explicit-`undefined` keys), so today's `ownerToken`, `inviteKey`, `resumeToken` and `durableSession` are refused, and so is any authority field a future `join` gains. Standalone authority never counts as Discord membership. The nickname is untrusted display text. Seats, holds and presence are keyed by the verified Discord user id, so a same-instance reconnect can reuse an M10 seat hold without a resume token. Activity rooms have no owner in v1: `snapshot.owner` is never true, and owner frames get `not_owner`. They are never listed in the directory, and a room id alone never admits.

The `ClientMessage` and `ServerMessage` unions, error codes and provider canonicalization are **unchanged**. Old servers and clients, standalone and the extension, see no difference. A pinned test keeps `admit` out of the room union.

### Lifetimes and revocation

| Constant | Value |
|---|---|
| `ACTIVITY_BOOTSTRAP_TTL_MS` (nonce) | 60 s, single use |
| `ACTIVITY_TICKET_TTL_MS` | 60 s, single use |
| `ACTIVITY_SESSION_MAX_MS` | 15 min hard limit, or OAuth `expires_in` if sooner, never renewed |
| `ACTIVITY_ADMISSION_DEADLINE_MS` | 5 s from upgrade to `admit` |
| `ACTIVITY_MEMBERSHIP_FRESHNESS_MS` | 30 s, the maximum age of the last successful instance check |
| `HANDOFF_CODE_TTL_MS` | 60 s for start → claim → confirm → redeem |
| `HANDOFF_GRANT_MAX_MS` | 15 min hard limit, never renewed |

The server keeps every admitted Activity membership backed by an instance check no older than 30 s; checks are coalesced per instance. If Discord answers 401/403/404, the user is missing from `users`, the session expired, or the user logged out, the server denies new operations and closes the socket with `CLOSE_CODES.SESSION_REVOKED` (4403); the client re-authorizes and doesn't auto-reconnect. On a 429 or an outage it honours `Retry-After`, and still revokes once the last success is older than 30 s. Revocation latency is therefore bounded by that window, not instant. Session ticket minting needs a membership result no older than that 30 s window: a cached one if fresh, else a new lookup.

One presence per verified user per room: a newer admission for the same user closes the older socket with `CLOSE_CODES.SESSION_REPLACED` (4007, ADR 0043).

### Handoff to the standalone site

The browser fallback is an explicit user action that transfers presence. It doesn't share it.

1. The Activity requests a code. There is one pending handoff per session, so a new start supersedes the old code (`handoff_invalid` from then on). The Activity then opens `https://<public origin>/handoff#h=<code>` (SDK `openExternalLink`). The code goes only in the fragment. The page reads it with `handoffCodeFromHash` (exact match) and clears the fragment immediately.
2. The standalone page claims it. The first claim wins; it gets a `receiver` secret and a 6-character `confirmCode` (Crockford base32, no I/L/O/U) shown on that page. A later claim gets `handoff_claimed`, so the user's page can say "this link was already used, start again in Discord".
3. The Activity user types the confirm code into the Activity. The server checks it against the pending claim. One well-formed wrong code cancels the transfer, so an intercepted link can't be confirmed blind (one 1-in-2³⁰ guess). A malformed entry is `invalid_body` and cancels nothing. The Activity never receives the code from the server.
4. Redeem needs `{ code, receiver }`. It returns `handoff_pending` with `retryAfterMs` until step 3 is done. On confirm, the server atomically marks the session **handed off**: it revokes the session's unused tickets and closes the Activity socket with `CLOSE_CODES.HANDED_OFF` (4008; don't reconnect). From then on that session's ticket and handoff routes answer `handed_off`, so a reloaded or modified Activity can't take presence back. A repeated confirm on that session also answers `handed_off`. Only the grant can mint tickets, and the standalone socket admits like any other, so exactly one presence exists durably. Redeem is retry-safe: repeating it with the same code and receiver within `HANDOFF_CODE_TTL_MS` of the confirm mints a new grant and revokes the previous grant and its unused ticket, so a lost response doesn't strand the user. To be in the Activity again, the user re-authorizes. Creating a new session for that user and room revokes their outstanding handoff grants, so presence can't bounce between the two surfaces; the new admission then replaces the standalone socket under the one-presence rule.

The grant is least-privilege. It is bound to that one room and user, carries no owner rights, isn't the Discord token, and is never extended by OAuth. It is delegated authority, **not** re-checked against Discord membership: the instance API can't tell leaving from removal, and the user leaving the Activity is the expected result of a handoff. The cost is bounded: a user removed from the Discord activity keeps standalone access to that room for at most `HANDOFF_GRANT_MAX_MS` (15 min). Logout, an in-room kick, room closure, explicit revocation and hard expiry revoke it. `HandoffTicketResponseSchema` therefore has no membership error codes. When the instance disappears, the room survives only until outstanding grants expire; a new instance always gets a new room. The extension still shares through its own per-member share token from the standalone snapshot, never a Discord credential. Until P0 proves this round trip on real clients, the server reports `capabilities.handoff: false` and handoff start returns `handoff_unsupported`.

### Discord upstream (`@omega/shared/discord-upstream`, server-only)

These are bounded schemas for `POST /oauth2/token`, `GET /users/@me` and `GET /applications/<app>/activity-instances/<instance>`. Unknown fields are stripped, so the refresh token, email and location are dropped at parse time. The token response must include the `identify` scope. `instanceAdmits` requires the returned app and instance to equal the expected ones and the verified user to be listed. It's a separate subpath export, so the web bundle never pulls it in. Signed proxy context (`X-Signature-Ed25519`) may later add defence in depth, but it doesn't replace the instance check.

## Consequences

- P0 implements the routes, the ticket store, the admission gate before pub/sub, the revalidation loop and the kill switch against this contract. The route table and the confirm-code UX may need amendments once real proxy and SDK evidence is in; those go through a contract issue, not P0's branch.
- Unauthenticated sockets are capped per ingress and globally (P0 picks the numbers with perf evidence). Discord's proxy collapses client IPs, so per-user and per-instance quotas replace per-IP limits for Activity routes.
- Accepted residual risk: anyone holding the link can claim first and so cancel the handoff (denial of service, not takeover). The legitimate page sees `handoff_claimed` and the user starts again.
- This adds no dependency. Admission work runs only at connect time, off the frame and sync hot paths.
