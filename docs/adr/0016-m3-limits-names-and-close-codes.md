# ADR 0016 — M3 limits, nickname normalisation, `rate_limited` retry hints and close codes

**Status:** accepted (2026-09-30) · [OME-186](/OME/issues/OME-186), research [OME-184](/OME/issues/OME-184) (`docs/research/m3-threat-model.md` §6–§7) · milestone [OME-183](/OME/issues/OME-183)

**Context:** M3 hardens the public room against floods, impersonation and ad hoc disconnects. The M2 boundary already size-checks and Valibot-parses every frame with strict client schemas. What was missing: a retry hint on `rate_limited`, close codes a client can act on, nickname rules that stop look-alike names, and chat rules that stop stray ZWJ and Zalgo stacks. This ADR fixes the **contract** (`packages/shared`). The server, web and extension hardening issues build on it.

## Decision

### 1. Limits: what is in the contract and what is not

The contract holds only limits that **both sides enforce**, because a client must not send what the server will refuse. They are in `packages/shared/src/constants.ts`, the single source:

| Constant | Value | Enforced by |
|---|---|---|
| `ROOM_ID_MAX_LENGTH` | 32 (`[a-z0-9-]`) | `RoomIdSchema` |
| `NICKNAME_MAX_LENGTH` | 20 UTF-16 units, **after** NFKC | `NicknameSchema` |
| `NICKNAME_MAX_MARK_RUN` | 2 combining marks in a row | `NicknameSchema` |
| `CHAT_MAX_LENGTH` | 280 | `ChatTextSchema` |
| `CHAT_MAX_MARK_RUN` | 3 combining marks in a row | `ChatTextSchema` |
| `MAX_URL_LENGTH` | 2048 (raw share URL) | `ShareRequestSchema`, `canonicalizeEmbed`, extension settings |
| `MAX_EMBED_URL_LENGTH` | 128 (canonical embed URL) | `control.url` |
| `MAX_CLIENT_MESSAGE_BYTES` | 4096 B | `parseClientMessage`, Bun `maxPayloadLength` |
| `MAX_SERVER_MESSAGE_BYTES` | 16384 B | `parseServerMessage` |
| `MAX_POSITION_S` | 43 200 s, finite | `PositionSchema` |
| `PLAYBACK_RATE_MIN` / `_MAX` | 0.25 / 2, finite | `PlaybackStateSchema` |
| `RETRY_AFTER_MAX_MS` | 60 000 | `RetryAfterMsSchema` |
| `RATE_LIMITED_RECONNECT_MS` | 10 000 | client reconnect after 4029 (advisory) |

`MAX_URL_LENGTH` and `MAX_EMBED_URL_LENGTH` moved from `embed.ts` to `constants.ts`. The public export names are unchanged. Nothing on the wire has a title, so there is no title limit.

**Rate numbers stay out of the contract.** Bucket sizes and refill rates (chat 5 / 1 s⁻¹, sit 4 / 1 s⁻¹, join 6 / 0.2 s⁻¹ per key, upgrade 10 / 0.5 s⁻¹ per key, room control 8 / 4 s⁻¹, room share 2 / 0.1 s⁻¹, ≤ 5 members per key per room, 4029 after 50 dropped frames, 4400 after 20 `bad_message`s) are **server-private** and recorded in `docs/research/m3-threat-model.md` §6. They can be tuned without a contract issue. Clients learn about them only through `retryAfterMs` and close codes, so they never hard-code them.

### 2. Nicknames

- `NicknameSchema` is **NFKC**, then trim, then length, shape and script checks. NFKC folds fullwidth and compatibility forms ("Ａｌｉｃｅ" becomes "Alice"). The length cap applies after normalising, because NFKC can expand a string (U+FDFA becomes 18 units).
- Bidi, zero-width, control and format characters are **rejected, not stripped**. Silent stripping would make the name the server shows differ from what the user typed. The web client shows the refusal instead.
- **Single-script rule:** Latin letters may not mix with Cyrillic, Greek, Armenian or Cherokee letters, the scripts that supply Latin look-alikes. A name wholly in one of those scripts is allowed ("Борис").
- `normalizeNickname(input)` returns the normalised nickname or `null`, and never throws. Both the server and the clients use it (the issue called this `normalizeDisplayName`; "nickname" is the domain term).
- `nicknameKey(n)`: NFKC, lower-case, NFD, all `\p{M}` removed. **The server enforces** that no two members of a room share a key, and it refuses the second `join` with `error nickname_taken`. This deliberately folds "José" and "jose" together.
- **Accepted / M4:** full UTS #39 confusables matching needs about 100 KB of data. A name wholly in Cyrillic that looks Latin ("аре") can still pass next to its Latin twin.

### 3. Chat text

`ChatTextSchema` adds NFC, allows ZWJ **only** between two `\p{Extended_Pictographic}` (with variation selectors and skin tones before it), and allows at most 3 combining marks in a row. Bidi and zero-width characters were already refused, since they are `Cf`. These rules are cosmetic hardening: the bubble clip bounds the damage.

### 4. Errors

- `error` (WS) and the share error (HTTP) get an optional `retryAfterMs` (integer, 0–60 000). **M3 servers set it on every `rate_limited`**, and HTTP 429 also carries `Retry-After` in seconds. It is **advisory**: the server's buckets are the enforcement, and a client that retries early is just refused again.
- New WS `ERROR_CODES`: `nickname_taken` and `too_many_members` (the per-key-per-room cap). For both, the socket stays open and unjoined, so the join timeout still applies and the user can retry with another name.

### 5. Close codes (`CLOSE_CODES`)

| Name | Code | Sent by | Client action |
|---|---|---|---|
| `HANDSHAKE_TIMEOUT` | 4000 | client | reconnect with backoff |
| `JOIN_TIMEOUT` | 4001 | server (was 1008) | reconnect normally |
| `ROOM_FULL` | 4002 | server, after `room-full` (was 1008) | stop |
| `SLOW_CONSUMER` | 4003 | reserved | (Bun closes slow readers itself with 1006) |
| `RATE_LIMITED` | 4029 | server, sustained flooding | wait `RATE_LIMITED_RECONNECT_MS`, then reconnect |
| `BAD_MESSAGES` | 4400 | server, repeated malformed frames | reconnect at maximum backoff |

**1006** covers everything the server cannot close with a code: oversize frames (Bun closes before our handler), backpressure over the limit, and refusals before the upgrade (HTTP 429/503, which a browser can't read). Clients treat 1006 as a network drop.

### 6. Strict objects

Every client → server variant stays a `strictObject` (extra keys are rejected), and so do `ShareRequestSchema` and `ShareTokenRecordSchema`. Server → client objects stay non-strict (extra keys are stripped). That is what lets `retryAfterMs` reach M2 clients without breaking them.

### 7. Not here

`status { catching }` / `member-status` (threat model §7.7) is the second M3 contract change, [OME-101](/OME/issues/OME-101). It rebases on this ADR and uses its `rate_limited` rules.

## Compatibility with M2 clients

Back-compatible:
- `retryAfterMs` on `error` and on the share error: old clients strip it.
- New constants and functions: additive.
- NFKC: an old client that sends "Ａｌｉｃｅ" is accepted as "Alice".

**Breaks, for the dependent issues to handle:**
- **Old web client + new server:** an `error` with `nickname_taken` or `too_many_members` fails `v.picklist`, so the old client drops the frame. The user sees nothing and stays unjoined until the join timeout. The site and server ship together (ADR 0015, one origin), so this only affects a stale tab. **Web issue:** handle both codes (this branch adds placeholder texts so `ERROR_TEXT` stays exhaustive).
- **Close codes 4001/4002 replace 1008.** The M2 web client ignores close codes (`apps/web/src/connection.ts`): it reconnects with backoff after any close, and stops only on the `room-full` message, which is sent before the close. So it keeps working, but it reconnects too early after 4029 and 4400. **Server issue:** switch to `CLOSE_CODES`. **Web issue:** act on the table above.
- **Stricter nicknames:** a mixed-script name ("Аlice") or a name with more than 2 stacked marks, sent by any client, is now `bad_message`. An old server that relays such a name to a new client makes the new client reject the whole `snapshot`. The server and site deploy together, so this is not a real case.
- **Stricter chat:** a stray ZWJ, or 4 or more stacked marks, is now `bad_message`. The same one-deploy argument applies.
- The extension only parses `ShareResponseSchema` and `ShareTokenRecordSchema`. Both are compatible, so **the extension needs no change**.

## Consequences

- The server hardening issue (WS) implements the buckets, `nickname_taken`/`too_many_members`, `retryAfterMs` and the close codes. The HTTP issue adds `retryAfterMs` and `Retry-After` on 429. The web issue maps the codes and backs off.
- Tuning a rate is a server change. Adding a close code or an error code is a contract change.
- Contract tests: `packages/shared/test/m3-contract.test.ts` (limit edges, NaN/Infinity, bidi/zero-width names, extra keys, key collisions).
