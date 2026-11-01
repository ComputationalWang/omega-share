# ADR 0043 — Durable room sessions across tab suspension and reload

- Status: accepted design (2026-10-11, Lead Engineer); implementation gated on the contract wave.
- Source: [OME-907](/OME/issues/OME-907), board item 6 in [OME-903](/OME/issues/OME-903#document-plan).
- Amends: ADR 0015 (share-token lifetime), ADR 0032 (ordinary disconnect versus restart holds). Contract proposal: [OME-908](/OME/issues/OME-908).

## Context

On `origin/main` at `92d6425`, `apps/web/src/room.ts` closes its connection and clears the share record on `pagehide`. `apps/server/src/ws.ts` calls `depart` on close, freeing the member, seat and share grant. Only a bfcache restore calls `resume`; a fresh `/r/<id>` load shows the Enter form. Server room state has seats but no standing position; `apps/web/src/stage.ts` and `walk/standing.ts` allocate standing spots locally, preserving them only in the current renderer.

A tab switch normally changes visibility, whereas history navigation can fire `pagehide`. Mobile suspension/discard can happen without a final page event. Therefore client events are hints and server disconnect handling must preserve membership independently. See the [Chrome lifecycle guide](https://developer.chrome.com/docs/web-platform/page-lifecycle-api). `sessionStorage` survives reloads and restores of the same page session, but closing the tab ends that session; see [MDN sessionStorage](https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage).

## Decision

### Identity, holds and expiry

The server mints a **room-bound resume token**, 32 random bytes encoded as 43 base64url characters, on a successful initial join explicitly opting in with `durableSession: true`. A legacy initial join without that field keeps immediate departure and grant revocation on socket close; it never receives a resume token or a grace hold. It sends the token only in that member's snapshot, never in room state, broadcast frames, URLs, analytics or logs. It is a bearer capability distinct from owner, invite and share tokens. The server keeps it in memory indexed by room and token; no new database persistence in this wave.

Web stores one validated record per room in `sessionStorage`, key `omega.resume.<roomId>`. The record contains room id, resume token, nickname and avatar. Use session storage rather than local storage to avoid sharing identity automatically between independent tabs and retaining credentials after tab closure. Storage failure degrades to the existing manual entry flow. Do not persist every frame or store arbitrary coordinates.

An unexpected socket close, including code 1000 without a prior `leave`, starts a **120,000 ms grace window**. Keep the member id, seat, standing slot, nickname reservation, mute state, owner grant, share grant and existing rate-limit buckets. Clear transient catching state. Mark the member away and publish one presence update. The member remains in snapshots and counts against both room capacity and its original per-client-key quota. Retaining an existing identity does not consume a second quota slot; a changed network address transfers its quota accounting atomically, refusing if the destination quota is full and retaining the original hold. New joins retain all current abuse checks.

At expiry, atomically revoke both tokens, release the seat, slot and nickname, and publish exactly one `member-left` with reason `left`. This is when chat gets the leave line. Explicit `leave`, kick, room removal and moderation takedown revoke immediately, bypassing grace. Kick must also work on held members; the current live-socket lookup is insufficient. Existing kicked-client cooldown still applies to new joins. Neither share requests nor visibility hints extend a disconnected hold. Held members keep a room occupied for GC; the 20-minute empty-room clock starts when the last hold expires or is revoked.

A matching token resumes the existing member before ordinary nickname/capacity allocation. Ignore join nickname/avatar changes for a resume: stored server identity is authoritative. A valid resume token proves the previous admission to a private room; no second invite is required. It restores the original owner status rather than promoting from new join fields. An absent token retains current normal-join admission rules. An unknown, expired, wrong-room or revoked token returns `resume_expired`, unjoined, without revealing which cause occurred; it must never silently allocate a fresh member. The client clears its stale record and shows ordinary entry, or the existing generic unavailable-room screen for room closure. It does not automatically bypass a kick by submitting a tokenless join.

Only one socket is live per token. A valid resume may atomically replace a still-open old socket (important when reload races server liveness detection). Install the replacement's connection generation, unsubscribe and detach the old socket, then close it with terminal `CLOSE_CODES.SESSION_REPLACED = 4007`. The old client stops retries and lifecycle-triggered reconnects, clears its resume/share records, and shows “This session is open in another tab” with an explicit “Return here” action. Retain the resume token only in the stopped page’s memory for that explicit action; a reload after replacement shows ordinary entry rather than automatically reclaiming it. “Return here” starts a new user-requested connection with that token and rewrites storage only after a successful snapshot; it must not run from visibility events. Every close/timeout callback verifies it still owns the generation before mutating membership or tokens. Publish no leave/join pair on resume. Send the returning client a current snapshot and publish `member-presence { away: false }` to other subscribers. Keep the same resume and share tokens through the session; disconnects and resumes do not refill buckets. Existing join/upgrade/frame limits apply to resume attempts and replacement churn.

### Position and presence

Allocate a unique **standing slot** (integer 0 through `MAX_ROOM_MEMBERS - 1`) to every member on first join, including seated members. Retain it through sitting, disconnect and resume. Derive its visual position from the existing ordered `standingPoints(layout)` list. This restores the standing destination on fresh load, and keeps observers consistent without publishing pixel coordinates, walking progress or motion frames. Seats remain authoritative for seated members. If the layout changes while away, keep the seat index/slot and map it into the new layout; exact old pixels cannot be promised. A slot beyond the available standing points has the existing off-stage fallback. Walking interpolation is cosmetic and restarts toward the retained destination.

Peers dim an away avatar and show an accessible Away label without removing it, freeing its seat, moving its anchor or emitting a leave line. Away is set on disconnect or a validated client visibility hint; it is not authority to close, reserve, kick or extend grace. A hidden but connected member remains joined without a disconnected expiry timer. Visibility changes are sent only on transitions, using the normal frame limiter. Away and catching are independent fields.

### Client lifecycle and sound

Do not send `leave` for `pagehide` or hiding. On plain hidden visibility, keep the existing socket and send the away hint best-effort; stop unnecessary render work. On `pagehide`/freeze, the client may close its socket for lifecycle compatibility but preserves resume and share records. Explicit Leave sends `leave` best-effort and clears both records immediately; if the frame is lost the server releases its hold at expiry.

Visible `visibilitychange`, `pageshow`, lifecycle `resume`, and fresh room boot all call one idempotent ensure-connected path. There is at most one connecting/open socket and one reconnect timer per client. Read and boundary-parse the room's stored record before deciding to show Enter. A record starts automatic join with its resume token; success goes directly into the room. If an open connection may have gone stale during suspension, use the existing ping/pong path with a bounded response timeout before replacing it. Failure uses existing jittered reconnect backoff; lifecycle events cannot start competing retry loops. Snapshot refreshes current embed, playback and queue even if they changed while away.

On automatic return, an autoplay rejection leaves the person in the room with a one-tap **Tap to unmute** button. The click calls the provider adapter's user-gesture sound/play path, then catches up to the room clock. It does not send a room-wide play command or display Enter. Handle provider-specific blocked-play notifications as well as rejected play promises; see [MDN autoplay guidance](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay).

### Extension and lifetime limits

Keep `sessionStorage["omega.share"]` and its existing strict `{ roomId, token }` shape. The extension continues its bounded one-shot read of that key; it never receives or reads a resume token. HTTP share and queue grants remain usable while disconnected **until the same hold deadline**, enforcing current control policy and member/room buckets. A share updates the room without requiring a running room-tab socket and does not renew the hold. Return gets the new embed in the snapshot. Expiry, leave and kick revoke the share grant immediately; a stale extension record receives the existing HTTP 401 and normal rejoin guidance. A fully discarded tab may need browser reload before extension script injection can succeed; this wave does not add persistent extension background work to evade browser lifecycle limits.

This wave guarantees restoration during a live server process and within grace. A crash/restart loses resume identities; tokens then fail as expired. ADR 0032's existing 30-second name-hash seat restoration remains available on a subsequent normal join but is not secure token resumption and must not grant session authority. Persisting resume sessions across server restart would require a separate storage/privacy decision and migration. Update user-facing retention documentation for the short in-memory disconnected-member lifetime when implementing the server wave.

## Exact shared-contract proposal for OME-908

All types derive from Valibot schemas. Client objects stay strict; additive server fields stay optional for legacy fixtures/servers.

| File | Exact additions or changes |
| --- | --- |
| `src/session.ts` (new) | `RESUME_TOKEN_LENGTH = 43`; `RESUME_GRACE_MS = 120_000`; `RESUME_STORAGE_KEY_PREFIX = "omega.resume."`; `ResumeTokenSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/))`; inferred `ResumeToken`; strict `ResumeRecordSchema` with required `roomId: RoomIdSchema`, `token: ResumeTokenSchema`, `nickname: NicknameSchema`, `avatar: AvatarSchema`; inferred `ResumeRecord`. Shape validation cannot prove entropy; generation is server-only. |
| `src/room.ts` | `StandingSlotSchema`: integer number from 0 through `MAX_ROOM_MEMBERS - 1`, inferred `StandingSlot`; optional `MemberSchema.away: boolean` (absent false) and `MemberSchema.standingSlot: StandingSlotSchema`. Add a `RoomStateSchema` check that all supplied slots are distinct, including seated/away members; legacy members without slots remain valid. |
| `src/messages.ts` client union | Optional `join.durableSession: v.literal(true)` to opt in on a tokenless initial join; optional `join.resumeToken: ResumeTokenSchema` for an existing durable identity (valid without repeating opt-in); new strict `{ type: "presence", away: boolean }`. No arbitrary position message. |
| `src/messages.ts` server union | Optional `snapshot.resumeToken: ResumeTokenSchema` and `snapshot.resumed: boolean` (absent false); new `{ type: "member-presence", memberId: MemberIdSchema, away: boolean }`; append `resume_expired` to `ERROR_CODES`. Snapshot tokens stay sender-only. Existing `member-joined` carries the optional slot via MemberSchema. |
| `src/constants.ts` | Add `CLOSE_CODES.SESSION_REPLACED = 4007`, terminal for automatic reconnect. Include it in close-code contract tests; no other new close code. |
| `src/share.ts` | Change lifetime documentation from revoked-on-close to revoked-on-explicit-leave/kick/hold-expiry. Existing schemas, HTTP bearer format, storage record and parsers are unchanged. |
| `src/index.ts`, `README.md` | Export `session.ts`; document resume, presence, standing slot and token separation/lifetimes. No provider allowlist change, other close code, frame-limit increase or dependency. |
| `test/` | Red-first tests: token length/character rejection; record unknown-key rejection; strict join/presence boundaries and opt-in rejecting false/non-booleans; new server frame parsing and old snapshots; slot bounds and duplicate-slot rejection; optional-field compatibility; maximum-capacity snapshot still within current frame budget. Pin exact new exports and documentation. |

Additive schema acceptance does not make old server/client implementations resume-aware. Merge contract first, deploy server support next, then enable web sending resume/presence. An old snapshot without a resume token keeps existing behavior; do not manufacture a token client-side. Existing clients retain their current immediate-departure behavior because they do not opt in. Web enables `durableSession: true` only once it can persist/resend tokens and handle the terminal replacement code. Server rollout must not expose credentials in broadcasts.

## Proposed implementation split and verification

1. **Contract — [OME-908](/OME/issues/OME-908), Lead:** merge the exact table above with its independent preset-id additions after judged design. Invoke the required TDD skill, commit failing contract tests before schema implementation, run shared tests/typecheck and `bun run affected`; green `check` and `e2e` plus normal review gate dependent work.
2. **Server — CEO files a bounded issue after C1 merges:** room/session state, generation-safe handoff, presence, hold expiry, held-member kick, HTTP share grants, quota transfer, legacy-versus-opted-in departure and GC integration in `apps/server/**`, plus retention documentation. Red-first fake-clock tests for expiry boundaries, capacity/nickname reservations, simultaneous replacements, terminal replacement closes and stale close callbacks, wrong-room/private tokens, moderation revocation, share-while-held without deadline renewal, bucket continuity and room deletion. No tests depend on sleeping for two minutes.
3. **Web — durable-session wave [OME-911](/OME/issues/OME-911), after C1 and server:** boundary-parsed room records, one connection state machine, bootstrap auto-entry, stable slots, away styling, unmute prompt and retained share record in `apps/web/**`. Unit-test event races/storage denial/expiry and terminal replacement preventing reconnect tug-of-war with fakes first; author deterministic reload/bfcache/return/standing-seat specs for CI. Keep serial with overlapping web claims. Extension production files need no change; server/web acceptance covers existing share-token injection and held HTTP shares, including 401 after expiry.

No per-frame session work, token polling, new renderer, new dependency or additional WebSocket. Allocate timers/maps only on membership transitions; at most one expiry timer per held member, bounded by existing room/member limits. Keep Bun room pub/sub; resume broadcasts one presence transition rather than a snapshot to all peers. Avatar tint changes only on presence events and preserves Pixi batching. Standing lookup changes only on membership/layout events. Preserve `docs/perf-budgets.md`: initial JS ≤200 KB gzip, frame work ≤8 ms p95, relay ≤50 ms (including flood). These are risk constraints, not measured results from this docs-only issue. QA's PR review measures relevant paths and real-provider autoplay/extension acceptance; CI owns deterministic e2e lanes. No local e2e/perf or post-merge QA pass is required here.

## Amendment 1 — `resume_expired` on an in-page reconnect (2026-10-12, Lead Engineer, [OME-911](/OME/issues/OME-911))

Resume tokens live in server memory only, so a graceful restart (1012) or a crash makes every token expire at once. Under the text above, every connected page would then stop on the expired card: each deploy would turn ADR 0032's "people barely notice" restart into a room full of people asked to enter again, and the M6 crash-recovery acceptance (`e2e/persistence.e2e.ts`) would fail.

Decision: the client tells the two cases apart by whether this page load has been in the room.

- **Cold boot** (fresh load or reload with a stored record, no snapshot yet on this page): `resume_expired` is terminal as specified above. Clear the record, show the card that leads back to Enter.
- **In-page reconnect** (this page has had a snapshot): drop the token and the record, and send **one** fresh join with `durableSession: true` under the same nickname and avatar. The fresh join carries no token, so it cannot be `resume_expired` again: no loop. Name/capacity refusals then follow the existing rules.

This does not undo a kick in production: the server's kick cooldown (ADR 0030) bounces the fresh join with 4005 and the page shows the removal notice. Loopback-only servers record no cooldown, the same as for a new tab today. A page that returns after its grace window has passed also comes back this way, as a new standing member; peers already saw its single leave line at expiry.

The stored record is not cleared on that fresh rejoin; its snapshot overwrites it. Clearing first would leave a window in which a killed tab reloads to the Enter form while its old member still holds the name.

**Duplicated tabs (accepted).** "Duplicate tab" and an opener-linked `window.open` copy `sessionStorage`, so the copy resumes the same token and the original gets 4007 and the "open in another tab" card with Return here. This keeps one member per token, as required, and is recoverable from either tab, so no per-load nonce is added.

## Amendment 2 — hand-off on tab close, and the creator goes straight in (2026-10-31, Lead Engineer, [OME-2075](/OME/issues/OME-2075))

Audit [OME-2064](/OME/issues/OME-2064#document-audit) items 4 and 5. Closing a tab ends its `sessionStorage`, but the server keeps the member (and the nickname) for the grace window: reopening the invite within it ended in "That name is taken". And the person who just created a room met the entry form a second time.

Decision:

- **Hand-off.** On `pagehide` the room page copies its stored resume record to `localStorage["omega.handoff.<roomId>"]` as `{ record, until }`, `until` = now + `RESUME_GRACE_MS`. Every boot of `/r/<roomId>` takes (reads and removes) that key; the tab's own `sessionStorage` record wins over it, and a valid unexpired one starts the usual automatic resume. A bfcache restore takes it back too. So while a tab is in the room there is no hand-off for a second tab to pick up, and the "never shared between independent tabs" rule above holds for live tabs. Explicit Leave, kick, expiry and replacement clear the session record first, so they hand nothing off. Parsed with Valibot at read; anything invalid, foreign or past `until` is dropped.
- Accepted: a tab that navigates away (bfcache) and is not restored leaves a hand-off that a new tab may take within the window; returning the old tab then replaces it with 4007 and Return here, as for duplicated tabs. A bearer token now sits in `localStorage` for at most one grace window after a close, or until the room's next boot; after that it is revoked server-side and a stale copy is only removed at that room's next boot.
- **Creator.** A successful create from the home page sets `sessionStorage["omega.pendingEnter.<roomId>"]`, the same hop as the pending layout; the room page takes it and, with a saved profile and no resume record, enters at once with that profile.

No contract, server or dependency change; the entry chunk grows by about 240 B gzip.

## Amendment 3 — the Leave key can be undone (2026-11-01, Lead Engineer, [OME-2105](/OME/issues/OME-2105))

Audit [OME-2064](/OME/issues/OME-2064#document-audit) item 9: Leave sits where people expect "back", and one tap dropped the seat for good. An explicit `leave` revokes the resume token at once, so nothing could take it back.

Decision:

- **The room bar's Leave key sends no `leave`.** It closes the socket (the server starts the usual grace hold, as for a closed tab), clears the session and share records, and puts the resume record and the room title in `sessionStorage["omega.left"]` as `{ record, title, until }`, `until` = now + 10 s. No hand-off is written. With no stored record it falls back to the explicit leave.
- **The landing takes that key at every boot** (read and remove, Valibot-parsed, dropped past `until`) and shows a fixed "You left <title> — Rejoin" chip until `until`; focus on it keeps it. Rejoin writes the record back as the room's session record and opens `/r/<roomId>`, which resumes as a reload does: same member, same seat, no chat lines. After the chip, the browser keeps nothing of the room beyond what it kept before (profile, room secrets).
- **The report dialog's leave stays explicit** (`leave` at once): leaving after a report should not be held.
- **Cost, accepted:** after Leave, peers see the member as Away until the hold ends (`RESUME_GRACE_MS`, 120 s), then one leave line, instead of an instant leave line. The share grant lives as long server-side, but the page has dropped its record. Sending `leave` when the chip expires would need a socket from the landing (a resume join and a leave, with a presence flicker for peers); not worth it now.

No contract, server or dependency change.
