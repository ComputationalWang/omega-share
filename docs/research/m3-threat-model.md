# M3 research: threat model and safety audit

Issue: OME-184 (parent OME-183). This audits `main` @ `186c13f`; all `file:line` references are to that commit. It follows `docs/research/m2-tunnel-safety.md` and ADR 0015. It does not repeat what they settled, such as the Host and Origin allowlists, the loopback bind, the member-bound share token and the edge gate.

Measured facts (Bun 1.4.2, on this machine, with throwaway probes, not committed):
- A frame over `maxPayloadLength` closes the socket with **1006** ("Received too big message"), not 1009. The client sees 1006 and cannot tell it from a network drop.
- With `backpressureLimit: 64 KiB, closeOnBackpressureLimit: true`, a raw TCP client that stops reading is closed with **1006**. Every `ws.send` after the first returns `-1`.
- `vite build` emits no inline `<script>` and no `new Worker`/`createObjectURL`. The only `style` writes are CSSOM `style.setProperty` (`apps/web/src/controls/dom.ts:79,134,185`), which `style-src` does not govern.

## TL;DR: what M3 does

The boundary is already strong. Every frame is size-checked, JSON-parsed and Valibot-parsed with `strictObject` before use. Every wire string is capped. Positions are finite and in range. Both apps render wire text with `textContent` only, and no `innerHTML` exists anywhere. Embed URLs go through exact-host allowlists and are rebuilt, not passed through. M3 closes these gaps:

1. **Per-type limits.** Chat, sit and join/leave share one 10/s per-socket bucket, so one member can fan out 250 frames/s to a full room. Connection *attempts* are not rate limited at all.
2. **Slow consumers.** `backpressureLimit` is unset, so up to 16 MB is buffered per socket, or 3.2 GB for 200 sockets. `ws.send`/`publish` results are ignored.
3. **Sustained abuse is never escalated.** A flooder gets one `rate_limited` notice and stays connected forever. Close codes are ad hoc (`1008` for join timeout and room full). `rate_limited` carries no retry hint.
4. **Impersonation.** Two members can both be "Alice". Mixed-script names ("Аlice" with a Cyrillic А) and fullwidth names pass.
5. **CSP.** The full policy is a `<meta>` tag. It is loose where it doesn't need to be (`connect-src ws: wss:`, `img-src blob:`, `worker-src blob:`, `style-src 'unsafe-inline'`, an unused `frame-src` origin). The server header carries only `frame-ancestors`. There is no Permissions-Policy or COOP/CORP, no Trusted Types, and no test that proves zero CSP violations.
6. **Room-level video/seek wars** are bounded per member but not per room.

Also: one contract issue (OME-186), a small no-behaviour server split so the WS and HTTP work don't share a file, four hardening issues and a QA issue (§9, §10).

## 1. Rate limits today

All limiters are `TokenBucket`s: burst, then refill per second (`apps/server/src/rate-limit.ts:4-24`, allocation-free). `KeyedLimiter` keeps at most 1024 keys and evicts the least recently used one (`rate-limit.ts:30-57`).

| # | Limiter | Key | Burst / refill | Scope | Overflow | Where |
|---|---|---|---|---|---|---|
| L1 | `bucket` | socket | 20 / 10 s⁻¹ | every frame, before parse | drop; one `error rate_limited` per streak; stays open | `server.ts:70-71,318,335-340` |
| L2 | `controlBucket` | socket | 4 / 4 s⁻¹ | `control` (after L1) | drop; one `rate_limited` per streak | `server.ts:73-74,277-282` |
| L3 | `shareLimiter` | client key | 5 / ⅓ s⁻¹ | `POST /share`, authorized | HTTP 429 `rate_limited` | `server.ts:75-77,116,177` |
| L4 | `grant.bucket` | member (token) | 5 / ⅓ s⁻¹ | same | 429 | `server.ts:251,177` |
| L5 | `globalShares` | none (process) | 20 / 2 s⁻¹ | same | 429 | `server.ts:82-83,117,177` |
| L6 | `failedShares` | client key | 20 / 1 s⁻¹ | unauthorized share | 429, else 401 | `server.ts:79-80,118,174` |
| C1 | `maxConnectionsPerIp` | client key | 10 behind proxy, 50 local | concurrent sockets | HTTP 429 before upgrade | `server.ts:111,310-312` |
| C2 | `maxConnections` | none | 200 | concurrent sockets | HTTP 503 before upgrade | `server.ts:112,309` |
| C3 | `MAX_ROOM_MEMBERS` | room | 25 | joined members | `room-full` then close 1008 | `room.ts:149`, `server.ts:242-245` |
| C4 | join timeout | socket | 10 s | unjoined sockets | close 1008 | `server.ts:109,209-214` |
| C5 | frame size | socket | 4096 B | every frame | Bun closes 1006 (measured) | `server.ts:330`, `constants.ts:10` |
| C6 | share body | request | 4096 B streamed, 64 KiB server-wide | share | 413 | `server.ts:68,180-184,297`, `rate-limit.ts:93-110` |

**Keying behind the tunnel.** `clientKey` trusts only the rightmost `X-Forwarded-For` entry, only with `trustProxy`, and only from a loopback peer. Any other XFF value becomes `proxy:unknown` (`rate-limit.ts:85-90`). IPv6 is keyed per /64 (`rate-limit.ts:63-75`). `scripts/tunnel.sh:33` sets `TRUST_PROXY=loopback`. `index.ts:395-397` warns when a tunnel runs without it. OME-179 verified that ngrok appends the client address. **No gap.**

**Gaps per message type:**
- `chat`, `sit`, `join` and `leave` have no limit of their own, only L1. Each one is a room-wide `publish` (`server.ts:254,271,274,226`). Worst case: one member sends 10/s × 25 recipients = 250 frames/s out. Ten sockets from one address can be ten members, so 2,500 frames/s from one address. A `join`/`leave` loop on one socket republishes `member-joined`/`member-left` 10 times a second and mints a new share token and grant bucket each time (`server.ts:249-251`). That second part also resets L4.
- **Connection attempts** have no limit. C1 caps concurrent sockets, but open → close → open is free, and each new socket starts with full L1/L2 buckets (`server.ts:318-320`). A reconnect loop therefore gets a fresh 20-frame burst every cycle.
- `ping` goes to the sender only and is covered by L1. Fine.
- `control` has L2 per socket, but no room aggregate: 25 members × 4/s = 100 `playback` broadcasts/s, or 2,500 frames/s.
- Share has no room-level limit. Twenty-five members can each switch the room's video every 3 s (L4). Only L5 caps the whole process.

**Caps.** Connections per key: C1. Per room: only joined members (C3). Unjoined sockets count only toward C1/C2 and live for at most 10 s (C4). **Rooms per key: not applicable.** Rooms are fixed at startup (`server.ts:114`) and nobody can create one. **Limiter-map memory is bounded:** `KeyedLimiter` holds at most 1024 keys (`rate-limit.ts:36,46-49`), `connectionsPerIp` holds at most C2 = 200 entries (`server.ts:115`), and `shareGrants` holds at most one entry per joined member (`server.ts:119,222,251`). LRU eviction lets someone with more than 1024 addresses reset their own L3/L6 buckets. **Accepted:** L5 still bounds the total, and 1024 distinct /64s or IPv4s is not a free-tier-tunnel threat.

## 2. WebSocket message validation

- **Every frame is parsed before use.** Binary frames become `bad_message` (`server.ts:341`). Text frames go through `parseClientMessage` (`packages/shared/src/messages.ts:133-135`), which checks UTF-8 length without allocating, then runs `JSON.parse`, then `v.safeParse` (`messages.ts:106-130`). `handle` only ever sees a `ClientMessage` (`server.ts:229`).
- **Unknown `type`:** `v.variant` fails and the client gets `bad_message`. **Extra keys:** every client variant is a `strictObject`, so they are rejected (`messages.ts:31-50`).
- **String caps:** nickname ≤ 20 (`packages/shared/src/room.ts:20-28`), chat ≤ 280 (`messages.ts:20-28`), `control.url` ≤ `MAX_EMBED_URL_LENGTH` (`messages.ts:46`), share `url` ≤ 2048 (`share.ts` `ShareRequestSchema`). Everything else is a number or a literal.
- **Numbers:** `PositionSchema` is `finite`, 0 to 43,200 s (`packages/shared/src/playback.ts:9`). `JSON.parse("1e999")` gives `Infinity`, which `v.finite` rejects, and JSON cannot express `NaN`. Seat, avatar and ping id are integers with ranges. `rate` is never client-sent; the server keeps the room's rate (`apps/server/src/playback.ts:256`). The server clamps positions again (`apps/server/src/playback.ts:223,249`). **No gap.**
- **Oversize:** Bun closes with 1006 before our handler runs (measured). The web client treats that as a drop and reconnects with backoff (`apps/web/src/connection.ts:91-105`). This is harmless, because our client never sends more than 4 KB. **Accepted**, with a test that pins it (§8).
- **Timeouts:** the join timeout is 10 s (C4). The client's handshake timeout is 10 s, closing with 4000 (`connection.ts:43,63-69`). `idleTimeout` and `sendPings` are not set, so Bun's defaults apply: 120 s and pings on (`bun-types/serve.d.ts:499,513`). **Gap (small):** set them explicitly (`idleTimeout: 60`) so the behaviour is pinned by a test, not by a Bun default.
- **Backpressure:** `backpressureLimit` and `closeOnBackpressureLimit` are unset, so the defaults apply: 16 MB, and never close (`serve.d.ts:484,491`). The results of `ws.send` and `server.publish` are ignored (`server.ts:206,198,226,254,271,274,288`). A client that stops reading makes the server buffer up to 16 MB of broadcasts for it, and 200 of them hold up to 3.2 GB. **Gap (M3):** set `backpressureLimit: 256 KiB` (about 50 full-room snapshots at `MAX_SERVER_MESSAGE_BYTES` = 16 KiB, `constants.ts`) and `closeOnBackpressureLimit: true`. Measured: Bun then closes the slow reader with 1006. `ws.send` results need no handling on top of that.
- **Fan-out cost for 25 members.** Each broadcast is one `server.publish`, which Bun copies into each subscriber in native code. Messages are 100–300 B, so the cost is frames/s, not bytes. With the limits in §6, the worst legitimate room is about 25 × (1 chat + 1 control + 0.2 sit) per second, roughly 1,400 frames/s out, which is well inside Bun's range. Today's worst case is 25 × 10/s × 25 = 6,250 frames/s. A new perf row (§8) makes this measurable against the ≤ 50 ms relay budget.

## 3. Input sanitization

User strings that reach other clients:

| String | Validated by | Normalised | Rendered by |
|---|---|---|---|
| Nickname | `NicknameSchema`: trim, NFC, 1–20, letters+marks/digits/`_.-`, single spaces, no Hangul fillers (`packages/shared/src/room.ts:13,20-28`) | NFC | web `textContent` in a `.tag-name` span (`apps/web/src/room.ts:302`); system lines via `textContent` (`controls/dom.ts:1,16`) |
| Chat text | `ChatTextSchema`: trim, 1–280, no `Cc`/`Cf`/`Zl`/`Zp` except ZWJ, no fillers, something visible (`messages.ts:20-28`) | **none** | `textContent` in `.bubble` (`room.ts:325`), clipped by `max-height: 180px; overflow: hidden` (`style.css:61`) |
| Room id | `RoomIdSchema` `^[a-z0-9-]{1,32}$` (`packages/shared/src/room.ts:7`) | n/a | web route falls back to the default room on a parse failure; extension `new Option(...)` (`apps/extension/src/entrypoints/popup/main.ts:86`) |
| Share URL | `canonicalizeEmbed`: ≤ 2048, http(s) only, no userinfo or port, exact host `Set`s, strict id regexes (`packages/shared/src/embed.ts:190-205,10,86-87,114,148`); the server rebuilds the URL (`server.ts:194`) | rebuilt canonical URL | never shown as text; the iframe `src` is rebuilt from a re-parsed `EmbedSchema` (`apps/web/src/tv.ts:67`) |
| Titles | none: no titles on the wire | | |
| Error `message` | server constants; ≤ 200 (`messages.ts:101`) | | `textContent` (web `room.ts:44-45` maps codes to fixed text; extension `share.ts` via `textContent`) |

`innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval` and `new Function` do not appear in `apps/web/src` or `apps/extension/src`. Pixi draws no wire text, because name tags and bubbles are DOM overlays. **No injection gap.**

Gaps:
- **Impersonation (M3).** Nicknames need not be unique. `\p{L}` admits any script, so "Аlice" (U+0410) passes next to "Alice". Fullwidth "Ａｌｉｃｅ" passes, because NFC does not fold it. Fix in the contract (§7): NFKC instead of NFC, a single-script rule, and a per-room uniqueness key. The server refuses a join with `nickname_taken`. Full UTS #39 skeleton matching (https://www.unicode.org/reports/tr39/ §4) needs the confusables table, about 100 KB of data. **M4 / accepted.**
- **Chat is not normalised, and ZWJ is allowed anywhere** (`messages.ts:25`). This is cosmetic, not dangerous: bidi controls U+202A–202E and U+2066–2069, LRM/RLM/ALM and zero-width U+200B/200C/2060/FEFF are all `Cf`, so they are already refused (UAX #9 Table 4, https://unicode.org/reports/tr9/). Fix in the contract: NFC, ZWJ only between two `\p{Extended_Pictographic}`, and at most 3 combining marks in a row (Zalgo). The bubble clip bounds the damage today, so this is low priority.
- The system line "Alice shared a video" uses the sharer's *nickname*, so uniqueness fixes spoofing there too. Chat bubbles and system lines are visually distinct (`.bubble` vs `.ui-sysline`), so chat text that imitates a system line is **accepted**.

## 4. CSP for the web app

Today:
- **Meta** (`apps/web/index.html:5-8`): `default-src 'self'; script-src 'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; worker-src 'self' blob:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com; object-src 'none'; base-uri 'none'; form-action 'none'`.
- **Header** (`apps/server/src/server.ts:89-93`, set on every response at `:138-141` and on `plain()` at `:94`): `frame-ancestors 'none'`, `nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.

Assessment against a strict target:
- `script-src`: there is no `unsafe-inline` or `unsafe-eval`, and the build emits no inline script (measured). The three SDK loaders assign `script.src` from constants (`apps/web/src/player/youtube-loader.ts:69-70`, `twitch-loader.ts:62-63`, `vimeo-loader.ts:62-63`). The path-scoped sources are right. **Keep.**
- `style-src 'unsafe-inline'`: our code only uses CSSOM (`style.setProperty`), which `style-src` does not govern. **Drop it**, provided the zero-violations e2e (§8) stays green with the fake SDKs and the real-provider run (`e2e:real`).
- `img-src data: blob:` and `worker-src blob:`: the built bundle has no `createObjectURL` or `Worker` (measured). **Drop `blob:`** from both. Keep `data:` until the violation test shows it unused.
- `connect-src 'self' ws: wss:` allows WebSockets to *any* host. CSP3 `'self'` already matches the page's `ws:`/`wss:` origin (CSP3 §1.3 and §6.7.2, https://www.w3.org/TR/CSP3/). **Header: `connect-src 'self'`.** In the meta, which Vite dev also uses, name the dev origins explicitly (`ws://localhost:8787 http://localhost:8787 ws://localhost:5173`) instead of `ws: wss:`.
- `frame-src`: `USE_NOCOOKIE = true` (`apps/web/src/tv.ts:37`), so `https://www.youtube.com` is never a frame. **Drop it** and keep `www.youtube-nocookie.com`, `player.twitch.tv` and `player.vimeo.com`. Iframes are already sandboxed (`tv.ts:44`, `room.ts:353-354`) with a `strict-origin-when-cross-origin` referrer, which YouTube requires (error 153 without a Referer: https://developers.google.com/youtube/iframe_api_reference).
- `frame-ancestors 'none'`, `base-uri 'none'`, `form-action 'none'`, `object-src 'none'`: present. `frame-ancestors` works only in the header (CSP3 §3.3). **Keep.**
- **Trusted Types.** Our only sinks are the three `script.src` assignments. The provider SDKs run in our document and may use other sinks we can't control. **M3: report-only.** Send `Content-Security-Policy-Report-Only: require-trusted-types-for 'script'; trusted-types omega-sdk`, and add one `omega-sdk` policy in the loaders that only passes the three SDK URLs. The e2e run collects violations. **Enforce in M4** if the real-provider run is clean. Report-only is header-only (CSP3 §3.3), which is another reason for the header.

**Header vs meta: use the header as the production policy, and keep the meta for dev.** A header applies before parsing and is the only way to get `frame-ancestors`, report-only and `report-to`. When both are present they *intersect*, so the effective policy is the stricter of the two. So:
- The server sends the full strict CSP on every response (§ gap table W-CSP). This is the effective production policy, because production is always same-origin (ADR 0015 §1).
- `index.html` keeps a meta that is a superset of it (dev origins named) so Vite dev stays protected.
- A server unit test pins the header string. The e2e zero-violation assertion runs through the server-served site (proxy fixture), so it tests the intersection.
- No `report-to` endpoint in M3. An unauthenticated report sink is a new abuse surface. e2e reads `securitypolicyviolation` events and console messages instead. **Accepted.**

Other headers:
- `X-Content-Type-Options: nosniff` and `Referrer-Policy: strict-origin-when-cross-origin`: present. **Keep.**
- `Permissions-Policy`: missing. Add `camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=()`. **Do not** list `autoplay`, `fullscreen`, `picture-in-picture` or `encrypted-media`. The player iframes are granted those through their `allow` attribute, and a header allowlist that omits the provider origins would block that delegation.
- `Cross-Origin-Opener-Policy: same-origin`: add it. Provider "watch on …" popups (`allow-popups-to-escape-sandbox`) open in a new browsing context group, and nothing we do needs `window.opener`.
- `Cross-Origin-Resource-Policy: same-origin` on our responses: add it. It affects only `no-cors` loads. The extension's `fetch` is CORS-mode, so it is unaffected.
- **No COEP.** `require-corp` would block the provider iframes and scripts, which don't send CORP (https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Cross-Origin-Embedder-Policy).
- `Strict-Transport-Security`: TLS ends at ngrok, and the server can't tell which requests arrived over HTTPS. **M4** (own hosting).

## 5. CSP and safety for the extension

- **Manifest** (`apps/extension/wxt.config.ts:13-21`): `activeTab`, `scripting` and `storage`. Host permission for the default server only. `optional_host_permissions` for `http(s)://*/*`, granted per origin at runtime. There is no `content_security_policy`, so the MV3 default applies: `script-src 'self'; object-src 'self'` (https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy). Remote code is already impossible. **Gap (small, M3):** declare `extension_pages: "script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"`. This is stricter than the default, the popup can't be framed by a page, and a static check on the built manifest pins it. `connect-src` stays open, because the user chooses the server origin.
- **Scan script:** `executeScript({ func: collectCandidateUrls })` in the ISOLATED world, on popup open only (`apps/extension/src/entrypoints/popup/main.ts:41`, `src/scan.ts`). It returns strings only. The popup re-validates every candidate with `canonicalizeEmbed` (`src/embeds.ts:16`) and shares the *canonical* URL. The server canonicalizes again (`server.ts:194`). A page can forge a candidate only for a real video on an allowlisted provider, which the user then picks from the list. **Accepted.** Host tricks (`youtube.com.evil.com`, `evil.com/?…youtube.com/embed/x`, `youtube.com@evil.com`, `:port`) fail the exact-host `Set` and userinfo/port checks (`embed.ts:198`).
- **Messaging:** there are no `runtime.onMessage`, `onMessageExternal` or `onConnect` listeners. The background script is empty (`src/entrypoints/background.ts:5`). `externally_connectable` is unset, so no web page can connect (https://developer.chrome.com/docs/extensions/reference/manifest/externally-connectable). **No gap.** A future listener must check `sender.id === runtime.id` and `sender.origin`.
- **Rendering:** text only (`popup/main.ts:75,86,92,109`, `options/main.ts:18`).
- **Share:** the server base URL must be a bare origin, cleartext only on loopback, a hostname and not an IP literal (`src/settings.ts:18-34`). A new origin needs a runtime `permissions.request` (`src/save-setting.ts:30`). Requests use `redirect: "manual"`, so the bearer token never follows a redirect (`settings.ts:66-69`). The token is read per popup open from `sessionStorage` of `${origin}/r/*` tabs only (`src/share-token.ts:19-34`) and never stored or logged. **Residual, accepted:** on loopback, any `localhost/r/*` tab on any port can supply a token record, because the local machine is trusted.

## 6. Abuse cases over the public tunnel

"Now" is the M3 fix. The numbers are recommendations for ADR 0016, and the server keeps them private (§7).

| Case | Today | Verdict and fix |
|---|---|---|
| Connection flood (concurrent) | C1 10/key, C2 200 total | **Accepted** for one key. About 20 keys can fill C2 (a DoS). **M4**, at an edge or hosting level. |
| Reconnect storm / connect churn | Not limited; each socket gets fresh buckets | **M3.** Add an upgrade limiter per key (`KeyedLimiter` 10 / 0.5 s⁻¹), which answers HTTP 429 before the upgrade. The web backoff (500 ms–5 s with jitter, reset only on a snapshot, `connection.ts:40-41,99-104`) stays well under it. |
| Join/leave churn | L1 only; mints a token each time | **M3.** A join limiter per key (6 / 0.2 s⁻¹) that answers `error rate_limited {retryAfterMs}` and leaves the socket unjoined. |
| Room squatting (25 fake members) | C3 25/room, C1 10/key, so 3 keys fill the lobby | **M3.** Add at most 5 joined members per key per room (`room_full`-style `error`). Real groups behind one NAT sit together, but see board question B2. |
| Room creation spam | Not applicable: rooms are fixed (`server.ts:114`) | **M4**, with dynamic rooms and SQLite. The rule then is creations per key per hour. |
| Share spam (switching the video) | L3 per key, L4 per member, L5 global; any member may share | **M3.** A room share limiter (2 / 0.1 s⁻¹, so at most one switch per 10 s per room after a burst of 2) → 429 with `retryAfterMs`. The actual fix, "only the host or a DJ may switch", is a **feature proposal (P-A)**. |
| Seek/pause war | L2 4/s per socket, no room aggregate | **M3.** A room control limiter (8 / 4 s⁻¹). |
| Chat flood | L1 only (10/s) | **M3.** A chat bucket per socket (5 / 1 s⁻¹). Sit gets 4 / 1 s⁻¹. |
| Sustained flooding | One notice per streak; never closed | **M3.** Close with **4029** after 50 dropped frames in a row. Close with **4400** after 20 `bad_message`s on one socket. |
| Name impersonation | Duplicates and mixed scripts allowed | **M3** contract (§7). Full confusables matching is **M4**. Mute and kick are **feature proposal P-B**. |
| Oversized frames | Bun closes 1006 | **Accepted.** Test it. |
| Malformed frames | `bad_message`, bounded by L1 | Covered. Add the 4400 close above and fuzz tests (§8). |
| Slow-read clients | Up to 16 MB buffered per socket | **M3.** `backpressureLimit: 256 KiB`, `closeOnBackpressureLimit: true`. Idle timeout set to 60 s explicitly. |
| Room-id enumeration | `GET /rooms` lists every room by design (`server.ts:156-160`) | **Accepted** while all rooms are public. With private rooms (M4), use unguessable ids and leave them out of the list. |
| Share-token replay/leak | 128-bit token, room-bound, revoked on leave/close (`server.ts:100,173,222`); only in the member's own `snapshot`; `sessionStorage` only, never in a URL (`apps/web/src/share-token.ts:17`); CORS with no-redirect | **Accepted.** An XSS is the only way to leak it, and CSP (§4) is that control. Rotating the token per share adds churn and no protection. |
| Hostile embed URL past the allowlist | Exact-host `Set`s, id regexes, rebuilt URLs, re-parse in `tvFrame`, sandboxed iframe | **Covered.** Add the fuzz corpus in §8 (unicode hosts, `%2e`, backslashes, IDN look-alikes such as `yоutube.com` with a Cyrillic о). |
| HTTP floods (`/rooms`, static files) | None beyond ngrok | **Accepted** for M3. The responses are cheap or static and ngrok rate-limits its free tier. **M4** with hosting. |

**Feature proposals for the CEO** (not part of M3):
- **P-A: room host / DJ.** The first joiner is host, and only the host (or people they allow) can share or seek. This is the real fix for video wars.
- **P-B: moderation.** The host can mute (drop chat) and kick (close with a code, plus a join ban per key for N minutes).
- **P-C: private rooms** with unguessable ids and invite links (M4, with dynamic rooms).

## 7. Contract changes (OME-186 / ADR 0016)

`packages/shared` changes. The rate numbers stay server-side in ADR 0016, not in the contract, so they can be tuned without a contract issue.

1. **`error` gets `retryAfterMs`:** `v.optional(v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(60_000)))`. The server sets it whenever `code === "rate_limited"`. This is back-compatible, because the server schema is a non-strict `object` and old clients strip the field (`messages.ts:56`).
2. **`ERROR_CODES` gets `"nickname_taken"`** (the join is refused and the socket stays unjoined, so the join timeout still runs) and **`"too_many_members"`** (the per-key-per-room cap; the socket stays open, unjoined).
3. **The share error** gets the same optional `retryAfterMs`. The server also sends `Retry-After` (seconds) on 429.
4. **`CLOSE_CODES`** as a const object with type:
   - `HANDSHAKE_TIMEOUT: 4000`: client-side, already used (`connection.ts:67`).
   - `JOIN_TIMEOUT: 4001`: replaces 1008 (`server.ts:212`). Client: reconnect normally.
   - `ROOM_FULL: 4002`: replaces 1008 (`server.ts:244`). Client: stop, as today.
   - `SLOW_CONSUMER: 4003`: reserved. Bun closes backpressured sockets itself with 1006 (measured), so we can't send it today. Keep it for a manual close if Bun gains a hook.
   - `RATE_LIMITED: 4029`: client waits `RATE_LIMITED_RECONNECT_MS = 10_000` before reconnecting.
   - `BAD_MESSAGES: 4400`: client reconnects at maximum backoff.
   - Document that 1006 covers oversize, backpressure and pre-upgrade refusals (429/503), which a browser can't read.
5. **Nicknames:**
   - `NicknameSchema` uses **NFKC** (instead of NFC) and allows at most 2 consecutive `\p{M}`.
   - Add a **single-script rule**: letters from Latin cannot mix with Cyrillic, Greek, Armenian or Cherokee letters. Test it with `\p{Script=…}`. This covers the look-alike pairs that matter for Latin names without a table.
   - Export `nicknameKey(n)`: NFKC, then `toLowerCase()`, then NFD with `\p{M}` removed. The server compares keys for uniqueness per room. This conservatively folds "José" and "Jose" together, which is acceptable.
6. **Chat:** `ChatTextSchema` gets `v.normalize("NFC")`, allows ZWJ only between `\p{Extended_Pictographic}`, and allows at most 3 consecutive `\p{M}`.
7. **OME-101 (`status { catching }`) under the same limits.** Client sends `strictObject { type: "status", catching: boolean }`. The server broadcasts `member-status { memberId, catching }` and adds optional `catching` to `Member` so the snapshot carries it. On the server:
   - It is state, not an event: store the latest value and broadcast only on change.
   - Trailing-edge coalescing: at most 1 broadcast/s per member, and the final value is always delivered.
   - It counts against L1 but gets no `rate_limited` error, because coalescing absorbs it.
   - The contract part goes in OME-186. The server and web parts stay in OME-101.

The contract tests are pure `bun test` in `packages/shared`: each rule gets accepted and rejected examples, including the confusable and fullwidth cases above.

## 8. Test strategy

**Merge-blocking** means part of `bun run check` or of the QA suite run after each merge.

| Test | Where | Blocking |
|---|---|---|
| Contract accept/reject tables for nickname (NFKC, script mix, mark runs, `nicknameKey` collisions), chat (NFC, ZWJ placement), `retryAfterMs` range, `CLOSE_CODES` values | `packages/shared/test` | yes |
| One test per limiter (L1–L6, plus the new upgrade/join/chat/sit/room-share/room-control/per-key-member limits): burst passes, next is refused with the right error and `retryAfterMs`, refill restores. Uses an injected clock, with no sleeps | `apps/server/test/abuse.test.ts` | yes |
| Escalation: 50 dropped frames → 4029; 20 bad frames → 4400; join timeout → 4001; room full → 4002 | `abuse.test.ts` | yes |
| Slow reader: raw TCP client stops reading, 1 MB of broadcasts → server closes it, other members' relay unaffected | `abuse.test.ts` | yes |
| Oversize frame → 1006, server stays up | `abuse.test.ts` | yes |
| **Fuzz:** seeded PRNG, 10k frames of random JSON, truncated JSON, wrong types, extra keys, huge numbers, `1e999`, lone surrogates, bidi and zero-width text. Invariants: never throws, never relays an invalid frame, room state still passes `RoomStateSchema` | `apps/server/test/fuzz.test.ts` (new) | yes (fixed seed; a nightly random seed is non-blocking) |
| **Embed fuzz:** hostile URL corpus (§6) plus mutations of valid URLs. Invariant: output is null or re-parses under `EmbedSchema` with an allowlisted host | `packages/shared/test/embed.fuzz.test.ts` (new) | yes |
| Header test: exact CSP, CSP-Report-Only, Permissions-Policy, COOP, CORP on HTML, JSON, 404 and `plain()` responses | `apps/server/test/boundary.test.ts` | yes |
| **Zero CSP violations:** a shared Playwright fixture adds an init script that records `securitypolicyviolation` events and fails the test on any enforced violation. Report-only (Trusted Types) violations are collected into a report instead | `e2e/support` fixture, used by **every** e2e spec | yes for enforced; report-only is non-blocking |
| Abuse e2e through the M2 reverse-proxy fixture (`e2e/fixtures/proxy.ts`, with `x-fixture-client` to play many addresses): per-key member cap, upgrade limiter keyed by XFF, a 4029 close and web backoff, `nickname_taken` UI | `e2e/abuse.e2e.ts` (new) | yes |
| Extension manifest static check: built `manifest.json` has the declared `extension_pages` CSP and no new permissions | `perf/static-checks.ts` or extension test | yes |
| **Perf row: relay latency under flood.** 24 members at the maximum *allowed* chat/control rates, plus 1 attacker socket flooding at 10× L1. Control-action relay latency p95 must stay ≤ 50 ms | `perf/server.perf.ts` + `relay-latency.ts` `--flood` | yes, as a new row in `docs/perf-budgets.md` |

## 9. Path split for the server issues

`apps/server/src/server.ts` holds the WS path and the HTTP path in one 369-line function. Two parallel issues would both edit it. So the first server issue is a no-behaviour split, done by the Lead, and it blocks both hardening issues:
- `server.ts`: composition only. It holds `Bun.serve`, Host/Origin checks, `ipOf`, `rooms`, `shareGrants` and the upgrade gate (C1/C2 and the new upgrade limiter). After the split nobody edits it except for wiring.
- `ws.ts` (new, owned by the **WS issue**): `ConnData`, `handle`, join timer, `depart`, `websocket:` handlers, message limiters and escalation.
- `http.ts` (new, owned by the **HTTP issue**): Hono app, CORS, `/rooms`, `/rooms/:id/share`, share limiters.
- `headers.ts` (new, **HTTP issue**): security headers and the CSP string.
- `static.ts`: **HTTP issue**.
- `room.ts`, `playback.ts`, `rate-limit.ts`: **WS issue**. `rate-limit.ts` gains an injectable clock. The HTTP issue imports it and does not edit it.
- `apps/server/test`: `abuse.test.ts` and `fuzz.test.ts` are the WS issue's. `boundary.test.ts` is the HTTP issue's.

The upgrade limiter lives in `server.ts`, but the split PR adds it as a stub hook, so the WS issue fills it in without editing `server.ts`. If the split issue slips, it is simpler to fold the upgrade limiter into the split itself.

## 10. Issues (proposed for the OME-183 plan)

| Id | Title | Owner | Paths | Blocked by |
|---|---|---|---|---|
| OME-186 | M3 contract (§7), ADR 0016 | Lead | `packages/shared/**`, `docs/adr/0016-*` | OME-184 |
| **new S** | Server split, no behaviour change (§9) | Lead | `apps/server/src/{server,ws,http}.ts` | none (can start now) |
| **new W** | WS hardening: per-type and room limiters, upgrade/join limiters, per-key member cap, escalation closes, backpressure/idle, nickname uniqueness | Lead | `apps/server/src/{ws,room,playback,rate-limit}.ts`, `apps/server/test/{abuse,fuzz}.test.ts` | OME-186, S |
| **new H** | HTTP hardening: full CSP header, CSP-Report-Only (Trusted Types), Permissions-Policy, COOP, CORP, room share limiter, `Retry-After` | Lead | `apps/server/src/{http,headers,static}.ts`, `apps/server/test/boundary.test.ts` | OME-186, S |
| **new C** | Web client: close codes and `retryAfterMs` backoff, `nickname_taken`/`too_many_members` UI, chat cooldown UI, tightened meta CSP, `omega-sdk` TT policy in the loaders | Lead (web) | `apps/web/**` | OME-186 |
| **new X** | Extension: explicit `extension_pages` CSP and manifest check | Extension Engineer | `apps/extension/wxt.config.ts`, extension test | none |
| **new Q** | QA: zero-CSP-violation fixture on all e2e, `abuse.e2e.ts` via the proxy fixture, embed fuzz review, flood perf row | QA Engineer | `e2e/**`, `perf/**`, `docs/perf-budgets.md` | W, H, C (the fixture can land first) |

OME-185 (frame p95) and OME-101 are independent of these. OME-101's contract part joins OME-186 (§7.7).

## 11. Board questions

- **B1. Anyone in a room can switch the video.** With the room limiter, a hostile member can still switch it once every 10 s. Is that acceptable for M3, with the host/DJ feature (P-A) planned for later? Recommendation: yes. The edge gate (ADR 0015, board decision B3) already limits who can reach a room.
- **B2. At most 5 members per address per room.** A group of more than 5 on one address (a LAN party, a school behind one NAT) would be refused. Is 5 acceptable, or should it be higher (10 = C1)? Recommendation: 5.
- **B3. Trusted Types** stays report-only in M3 and is enforced in M4 if the real-provider runs are clean. This needs no decision unless the board wants enforcement now.

## Gap table

| Threat | Current control (file:line) | Gap | Fix | Owning issue | Proving test |
|---|---|---|---|---|---|
| Chat fan-out flood | L1 `server.ts:70-71,335` | No chat-specific limit; 250 frames/s per member | Chat bucket 5 / 1 s⁻¹ | W | `abuse.test.ts` chat limiter; flood perf row |
| Sit spam | L1 | Same | Sit bucket 4 / 1 s⁻¹ | W | `abuse.test.ts` |
| Join/leave churn | L1; token mint `server.ts:249-251` | Unlimited republish and token mint | Join limiter per key 6 / 0.2 s⁻¹ + `retryAfterMs` | W (+ OME-186 field) | `abuse.test.ts` |
| Reconnect churn | C1 `server.ts:310-312` | Attempts unlimited; fresh buckets | Upgrade limiter per key 10 / 0.5 s⁻¹ → 429 | S hook, W fills | `abuse.test.ts`; `abuse.e2e.ts` via proxy XFF |
| Room squatting | C3 `room.ts:149`, C1 | 3 keys fill a room | ≤ 5 members per key per room, `too_many_members` | W (+ OME-186 code) | `abuse.test.ts`; `abuse.e2e.ts` |
| Seek war | L2 `server.ts:277-282` | No room aggregate | Room control bucket 8 / 4 s⁻¹ | W | `abuse.test.ts` |
| Video-switch war | L3–L5 `server.ts:177` | No room limit | Room share bucket 2 / 0.1 s⁻¹ + `Retry-After` | H | `boundary.test.ts`/`abuse.test.ts` share case |
| Sustained flood never escalated | one notice `server.ts:336-338` | Socket lives forever | 4029 after 50 dropped; 4400 after 20 bad | W (+ OME-186 codes) | `abuse.test.ts` |
| No retry hint | `error` `messages.ts:98-102` | Clients guess | `retryAfterMs`, `Retry-After` | OME-186, then W/H/C | shared tests; `abuse.e2e.ts` |
| Ad hoc close codes | 1008 `server.ts:212,244` | Client can't tell why | `CLOSE_CODES` 4001/4002/4029/4400 | OME-186, W, C | `abuse.test.ts`; `connection` unit tests in web |
| Slow reader | none (Bun default 16 MB, `serve.d.ts:484,491`) | Up to 3.2 GB buffered | `backpressureLimit` 256 KiB + close | W | `abuse.test.ts` slow reader |
| Idle policy implicit | Bun defaults `serve.d.ts:499,513` | Unpinned | `idleTimeout: 60`, `sendPings: true` explicit | W | `abuse.test.ts` |
| Malformed frames | `parseClientMessage` `messages.ts:133` | No fuzz coverage | Seeded fuzz | W | `fuzz.test.ts` |
| Name impersonation | `NicknameSchema` (`packages/shared/src/room.ts:20-28`) NFC | Duplicates, mixed script, fullwidth | NFKC, single script, `nicknameKey` uniqueness, `nickname_taken` | OME-186, W, C | shared tests; `abuse.test.ts`; `abuse.e2e.ts` |
| Chat Zalgo / stray ZWJ | `ChatTextSchema` `messages.ts:20-28` + CSS clip `style.css:61` | Cosmetic | NFC, ZWJ placement, mark runs ≤ 3 | OME-186 | shared tests |
| Hostile embed URLs | `embed.ts:190-205`, `tv.ts:67` | No fuzz corpus | Embed fuzz | OME-186 (test only) + Q review | `embed.fuzz.test.ts` |
| CSP only in meta | `index.html:5-8`; header `server.ts:89-93` | No header policy; `ws: wss:` any host; `blob:`, `unsafe-inline` style, unused frame origin | Strict header CSP; tightened meta | H (header), C (meta) | `boundary.test.ts` header; zero-violation e2e |
| No Trusted Types | none | `script.src` sinks unguarded | Report-only TT + `omega-sdk` policy | H (header), C (policy) | zero-violation fixture (report) |
| Missing Permissions-Policy / COOP / CORP | none (`server.ts:89-93`) | Missing | Add (§4) | H | `boundary.test.ts` |
| No CSP regression proof | none | Violations unseen | e2e `securitypolicyviolation` fixture on every spec | Q | the fixture itself |
| Extension CSP implicit | MV3 default (`wxt.config.ts` has none) | Unpinned; popup frameable | Explicit `extension_pages` | X | manifest static check |
| Relay under flood unmeasured | relay budget ≤ 50 ms (`docs/perf-budgets.md`) | No flood scenario | `--flood` perf row | Q (+ W for `relay-latency.ts`) | `server.perf.ts` flood row |
| Connection flood across keys | C2 200 `server.ts:112,309` | ~20 keys fill it | none in M3 | **M4** (hosting/edge) | none |
| HTTP floods | none | ngrok only | none in M3 | **M4** | none |
| Share-token leak | room-bound, revoked, `sessionStorage` only (`server.ts:173,222`, web `share-token.ts:17`) | Only via XSS | CSP (above) | accepted | existing `share-token.test.ts` |
| Room-id enumeration | public list `server.ts:156` | By design | none | accepted (M4 private rooms, P-C) | none |
| Full confusables | none | TR39 skeleton | none in M3 | **M4** | none |
