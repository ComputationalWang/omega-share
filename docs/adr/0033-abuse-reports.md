# ADR 0033 — Abuse reports: "report this room", the operator queue and takedowns

**Status:** accepted (2026-10-09) · Lead · [OME-592](/OME/issues/OME-592) · plan [OME-538](/OME/issues/OME-538#document-plan) item 6 · keeps [ADR 0028](0028-room-ownership-and-private-rooms.md) §7 (no personal data persisted for abuse controls) and the [ADR 0020](0020-hosted-topology.md) §3 claim (no visitor IP or headers on disk) · builds on the operator socket from ADR 0028 (`apps/server/src/admin.ts`, `cli.ts`) · close codes from [ADR 0016](0016-m3-limits-names-and-close-codes.md)

**Context:** M7 opens the beta. Anyone can create a room and share a video into it, so someone will eventually share sexual content, gore or hate, or use a room to harass people. Room owners can kick and mute (ADR 0030), but nobody can act on a room whose owner is the problem. People in the room need a way to tell the operators, and the operators need a queue and a way to close the room. There are no accounts, and we keep it that way: a report must not need one, and must not turn into a record of who reported whom. This ADR records the `packages/shared` contract (C1). The server (S1 [OME-595](/OME/issues/OME-595)) and the site (W6 [OME-601](/OME/issues/OME-601)) build on it.

(The issue cites "ADR 0027" for privacy. The privacy rule for abuse controls is ADR 0028 §7; 0027 is about seek-only providers.)

## Decision

### 1. A REST route, not a WebSocket frame
`POST /rooms/:id/report` with a JSON body. A report is one-shot, has to work for someone who was refused a seat (room full, kicked, private room without the key) and shouldn't share the socket's 4400 budget. It needs **no token**: no share token, owner token or invite key. A room id is not a secret (ADR 0028 §4), so knowing one only lets you report it.
- Path: the room id, parsed with `RoomIdSchema` (failure → `room_not_found`, never an echo of the input).
- Body: **`ReportRequestSchema`**, a `strictObject` `{ reason, note? }`, at most **`MAX_REPORT_BODY_BYTES` = 2048** raw bytes (checked before `JSON.parse`, like the other routes; the largest valid body is under 1 KiB, test). Strict means nothing about the reporter fits in it: no nickname, member id, contact address or page URL.
- `reason`: **`REPORT_REASONS`** = `sexual`, `violence`, `hate`, `spam`, `danger`, `other`. These are the six rows of the set (k) dialog ("Sexual content", "Violence or gore", "Hate or harassment", "Spam or scams", "Someone may be in danger", "Something else"). The issue suggested `illegal`; the design's `danger` is more useful to the operator, and illegal content falls under one of the others or `other`.
- `note`: optional **`ReportNoteSchema`**. Bounded to 600 UTF-16 units *before* any regex runs, line breaks and tabs turned into one space, then chat's own rules (`plainTextSchema`, shared with `ChatTextSchema`): trimmed, NFC, **1–`REPORT_NOTE_MAX_LENGTH` = 300**, no control, format or bidi characters, at most 3 combining marks in a row, something visible. A blank note fails the parse, so the site leaves `note` out instead of sending `""`.

### 2. Answers
**`ReportResponseSchema`**:
- `202 { ok: true, status: "received" }`: stored.
- `200 { ok: true, status: "already_reported" }`: the same client key already reported this room in the last `REPORT_RETENTION_MS`. **Nothing new is stored**, and the reason and note of the second attempt are dropped. The site shows it the same way as "received" plus "already reported". It's a success, not an error, so a reporter isn't told off for pressing Send twice.
- Errors, `{ ok: false, error: { code, message, retryAfterMs? } }`, codes **`REPORT_ERROR_CODES`**: `invalid_body` 400 (bad JSON or schema), `payload_too_large` 413, `room_not_found` 404 (no such room, or taken down), `rate_limited` 429 with `Retry-After` and `retryAfterMs` ≤ `REPORT_KEY_REFILL_MS`, `unavailable` 503 (open-report cap reached, or the store failed; nothing stored).
- No answer carries a report id, a count, or anything about other reports or reporters. The check order is: body size → room exists → key bucket → room bucket → duplicate → cap → store. A request takes from a bucket only if the room exists, so random ids can't drain them; a duplicate still takes from the key bucket, so `already_reported` can't be used to probe without limit.

### 3. What is kept, and for how long
The server writes one row per accepted report to SQLite, table `reports` (S1, next free migration):

| Column | What |
|---|---|
| `id` | random, 16 bytes base64url; the operator's handle, never sent to the reporter |
| `room_id` | the reported room |
| `reason` | one of `REPORT_REASONS` |
| `note` | the parsed note **after redaction**, or null |
| `room_title` | the room's title at report time (the title itself may be the abuse; owners can rename) |
| `embed_url` | the canonical URL of what was playing at report time, or null; this is the evidence and may be gone by the time an operator looks |
| `created_at` | Unix ms |
| `state` | `open`, `dismissed` or `actioned` |

**Nothing about the reporter is stored**: no address, hashed or HMACed address, client key, user agent, member id, nickname, share or owner token, and no `Referer`. This is ADR 0028 §7 unchanged. The report's own content (reason, note, room snapshot) is about the room, not the reporter.

- **Redaction:** before the note is stored, the server replaces email addresses with `<email>` and IPv4/IPv6 addresses with `<ip>`, using the patterns of `apps/server/src/log.ts` (the error-log scrubber, OME-536/548/579), and phone-number-like runs of 7 or more digits (spaces, dots, dashes and a leading `+` allowed between them) with `<phone>`. A reporter who types their own contact details shouldn't leave them on disk. Links stay: a URL to the content is useful evidence.
- **Retention:** every row is deleted **`REPORT_RETENTION_MS` = 30 days** after `created_at`, whatever its state, by the existing GC sweep. Nightly backups hold copies until they rotate out (14 snapshots, ADR 0020 §11 as amended), so a report is fully gone at most **44 days** after it was made.
- **Duplicate detection is in memory only:** a per-room set of the client keys that reported it, cleared after `REPORT_RETENTION_MS` and by a restart (a restart may let one key report a room twice; that's fine). Same key as every other bucket (ADR 0028 §7). If the request has no usable client key, there's no duplicate check; the room bucket and the global cap still apply. The set is never written to disk, logged or put in metrics.
- **Logs and metrics:** a report is never logged. `/metrics` (localhost only) counts reports by reason and outcome (`received`, `already_reported`, `rate_limited`, `unavailable`), takedowns and the open-report gauge. No room ids or notes.
- **Privacy notice:** `privacy.html` gains a "Reports" section saying exactly this (W6 ships it with the dialog).
- **What the dialog promises:** "It goes to them only, not to the host or anyone in the room." That's true: no frame, snapshot field or REST answer exposes a report to anyone but the operator socket.

### 4. Limits
In memory, keyed and reset like every other abuse bucket:
- Per client key: **`REPORT_KEY_BURST` = 3**, then one every **`REPORT_KEY_REFILL_MS` = 10 min**. Nobody needs more to report the rooms they're in; a raid needs many addresses.
- Per reported room, across all reporters: **`REPORT_ROOM_BURST` = 20**, then one every **`REPORT_ROOM_REFILL_MS` = 1 min**. Twenty reports already put a room at the top of the queue; more would only fill the table. A real crowd reporting one room gets `rate_limited` past 20, which the site words as "try again later" — we accept that, because the room is already flagged.
- Whole server: at most **`REPORT_MAX_OPEN` = 1000** open reports. Past it, `unavailable`. With retention and the room bucket this bounds the table; an operator who sees the gauge at the cap dismisses or takes down rooms.

### 5. The operator side (S1)
Only through the operator socket (ADR 0028: owner-only Unix socket, `cli.ts` its only client). **Never public HTTP.**
- `cli.ts reports list`: open reports grouped by room, most reported first. Per room: id, current title (or "taken down"/"gone"), visibility, member count now, number of open reports and their reasons, newest first with `created_at`, reason, note, the title and embed URL at report time. Nothing else exists to show.
- `cli.ts reports dismiss <reportId|--room roomId>`: marks reports `dismissed`. Dismissing a room's reports doesn't block new ones.
- `cli.ts rooms takedown <roomId>`: in one step
  1. writes the room id to a **`takedowns(room_id PRIMARY KEY, at)`** table; a room id is not personal data, so it is kept indefinitely;
  2. ends the live room through `removeRoom` with **`CLOSE_CODES.TAKEN_DOWN` = 4006** (the next free code) instead of `ROOM_CLOSED`, revoking every share grant, so pending shares and queue adds get `room_not_found`;
  3. deletes the room row and its seat holds and queue, as `DELETE /rooms/:id` does;
  4. marks the room's open reports `actioned`.
- After a takedown the id stays dead: `POST /rooms` never mints it (the id check includes `takedowns`), a seeded room with that slug isn't re-seeded at startup, a `join` to it is closed with 4006 before any snapshot, and `share`, `queue` and `report` answer `room_not_found`. It's left out of `GET /rooms`.
- There's no undo command. Undoing means deleting the `takedowns` row by hand (runbook), and the room comes back empty, with no owner.
- **What a takedown can't do:** with no accounts, the owner can create a new room and share the same thing again. The operator takes that room down too. If it keeps happening, the break-glass ban in ADR 0028 §7 is the escalation path, and it still needs its own ADR. Edge rate limits come first.

### 6. What people see
- **Reporter:** "Thanks, we got it. Someone will look at this room. We can't reply here." (set (k)), then a sunk "Reported" key until they leave the room; `already_reported` shows the same. Reporters are never told the outcome: there's no account to tell, and the report stays anonymous.
- **Members after a takedown**, including the owner and the reporter if they're still in: the socket closes with 4006. The site doesn't reconnect and shows a plain notice: "This room was closed by the omega-share team after a report." It drops the room from `omega.rooms` like after `ROOM_CLOSED`. Opening `/r/<id>` later shows the same notice.
- **Old clients** (pre-M7 site) treat 4006 as an unknown code: they reconnect with backoff and get 4006 again. That's harmless and stops when they reload.
- **Owner:** nothing more than the members get. The notice doesn't say who reported or why.

## Consequences
- `packages/shared` gains `report.ts` (`ReportRequestSchema`, `ReportNoteSchema`, `ReportResponseSchema`, `REPORT_REASONS`, `REPORT_STATUSES`, `REPORT_ERROR_CODES`), the `REPORT_*` limits and `MAX_REPORT_BODY_BYTES` in `constants.ts`, `CLOSE_CODES.TAKEN_DOWN`, and `plainTextSchema(maxLength)` in `messages.ts`, which `ChatTextSchema` is now built from (same rules).
- S1 adds a migration (`reports`, `takedowns`), the route, the buckets, the in-memory duplicate set, GC purging, the CLI commands, metrics and a `docs/ops/` runbook entry.
- W6 adds the dialog, the 4006 notice and the privacy notice section. It's idle DOM, so no frame-budget change.
- Reports are an operator workload: the beta's operators check `cli.ts reports list` daily. If that becomes too slow, a notification (ntfy) on the first report for a room is a follow-up, not part of this ADR.
