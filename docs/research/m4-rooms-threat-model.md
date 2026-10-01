# M4 research: room creation, owner tokens, private rooms (P-C), persistent abuse controls

**Status:** research, 2026-10-01 · [OME-275](/OME/issues/OME-275) · plan [OME-270](/OME/issues/OME-270) · Lead Engineer
**Builds on:** `docs/research/m4-hosting-and-sqlite.md` (OME-260, called "hosting research" below), `docs/research/m3-threat-model.md` (OME-184), ADR 0015 (share token), ADR 0016 (limits), ADR 0018 (WS limits, loopback keys), ADR 0021 (room layout v1, OME-271, on its branch and not yet on `main`), the SQLite store (OME-277, on its branch).

The hosting research left one follow-up contract open: **"room ownership + layout editing"** (its §3 and §6 #12). This addendum is that contract's threat model. It also covers the M3 carry-overs that need dynamic rooms: room-creation spam (M3 threat model §6, "Room creation spam"), private rooms (P-C, M3 §6), and room-id enumeration (M3 §6, "accepted until private rooms").

## TL;DR

- **`POST /rooms`** creates a room from `DEFAULT_LAYOUT`. The server picks the id, never the client. Limits: a **per-key creation bucket** (2 at once, then 1 every 10 min), a **global creation bucket** (10 at once, then 1 a minute), and **`MAX_ROOMS = 500`** stored rooms. Once the cap is reached the server refuses new rooms (`503 too_many_rooms`). It never evicts someone else's room.
- **GC:** seeded rooms are pinned and never collected. A created room that **nobody ever joined** is deleted after **1 h**. A created room that has been **empty for 14 days** is deleted. A sweep runs hourly and at boot. Deletion removes the whole row (layout, embed, title, owner hash). Nothing is kept except the nightly backups, which age out after 14 days.
- **Owner token:** 16 random bytes in base64url (the share-token shape). It is minted **only** in the `POST /rooms` response body, never in a URL, a snapshot or a broadcast. The server stores **only `SHA-256(token)`**. The site keeps it in **`localStorage`**, not `sessionStorage` (§2.3 explains why this one rule differs from ADR 0015 §7). It allows **layout edits, renaming and deletion**, nothing else. **No recovery:** a lost token leaves an ownerless room that GC collects once it is idle.
- **Private rooms (P-C):** every created room, public or private, gets a **128-bit random id**: 26 chars of lowercase base32. That id already fits `RoomIdSchema` (`[a-z0-9-]{1,32}`), so the id format needs no contract change. **The id alone is not the capability**: the Twitch SDK sends the full page URL to Twitch (ADR 0015 §8, ADR 0014), so room ids leak. A private room also needs an **invite key** (128 bits). It travels only in the invite link's **fragment**, `/r/<id>#k=<key>`. The site strips the fragment with `history.replaceState` at boot, before any provider SDK loads, and keeps the key in `localStorage`. The server checks it at `join` against a stored hash. Private rooms are **never in `GET /rooms`**, and visibility is fixed at creation. Keep `Referrer-Policy: strict-origin-when-cross-origin`. Add `X-Robots-Tag: noindex` on `/r/*`.
- **Persistent abuse controls: recommend persisting nothing about people in M4.** Every abuse control stays in memory, keyed by address, as today. Hashed-address bans with a TTL are still **personal data** under GDPR (pseudonymised, not anonymous: an IPv4 hash can be reversed by brute force). They also add little against our real threats. A break-glass design is written down (§4.3), but it is not built.
- **Contract:** `CreateRoomRequest` / `CreateRoomResponse`, an `OwnerTokenSchema` / `InviteKeySchema`, `RoomSummary.title`, a `RoomTitleSchema`, `join.ownerToken?` / `join.inviteKey?` (optional), `invite_required`, `snapshot.owner?`, client messages `layout-set { layout }` and `title-set { title }` (owner only), server messages `layout-changed` and `title-changed`, `DELETE /rooms/:id`, and a close code `ROOM_CLOSED = 4004`. A full `layout-set` is about **2.1 KB**, inside `MAX_CLIENT_MESSAGE_BYTES` (4 KB).
- **One server fix is needed whatever we decide:** the per-room bucket maps in `http.ts:65-74` and `ws.ts:113-122` assume "rooms are fixed at startup" and would leak with dynamic rooms.

## 0. Today's code (the baseline)

| What | Where | Note for M4 |
|---|---|---|
| The room set is fixed at startup, default `["lobby"]` | `apps/server/src/server.ts:28-29,45` | Becomes the rooms loaded from the DB (OME-277), plus created rooms |
| WS upgrade: room lookup → **404 before any limiter** → caps → `admitUpgrade` | `server.ts:94-104` (404 at `:96-97`, limiter at `:102`) | Unknown-id probes aren't rate-limited (§3.3) |
| `GET /rooms`: first `MAX_LISTED_ROOMS` rooms in insertion order | `apps/server/src/http.ts:95-99`, `packages/shared/src/rooms-list.ts`, `constants.ts:24-25` | Must filter private rooms and pick which 100 to show |
| `RoomSummary { id, memberCount, seatedCount }` | `packages/shared/src/rooms-list.ts:6-14` | Gains `title` |
| `RoomIdSchema` `[a-z0-9-]{1,32}` | `packages/shared/src/room.ts:14`, `constants.ts:7-8` | 26-char base32 ids fit |
| Share token: 16 random bytes in base64url, minted at join, in the member's own snapshot only | `apps/server/src/ws.ts:80-81,232-236`; schema `packages/shared/src/share.ts:6-26` | The owner token reuses this shape and parser |
| Share auth: Bearer header, a separate failed-auth bucket, 401 | `http.ts:116-126` | The pattern for `DELETE /rooms/:id` |
| Share grants revoked on leave or close | `ws.ts:166` | Room delete must close sockets, which revokes the grants |
| Per-room buckets kept in `Map<Room, TokenBucket>`, "rooms are fixed at startup" | `http.ts:65-74` (share), `ws.ts:113-122` (control) | **Leaks with dynamic rooms.** Fix: a `WeakMap`, or delete on room removal |
| Keyed limiters, LRU-capped at 1024 keys | `apps/server/src/rate-limit.ts:48-81` | The creation bucket reuses `KeyedLimiter` |
| Client key: the address (IPv6 by /64), XFF only from a loopback peer | `rate-limit.ts:87-122` | The key for creation limits; it stays in memory only |
| Join: room cap, nickname key, per-key member cap | `ws.ts:209-236`, `apps/server/src/room.ts:62` | `join.ownerToken` is checked here |
| Strict client frames, 4 KB cap | `packages/shared/src/messages.ts:48-73,172`; `ws.ts:305` (`maxPayloadLength`) | New client messages must be `strictObject` |
| Referrer: header `strict-origin-when-cross-origin`, meta tag, iframe attribute | `apps/server/src/headers.ts:46`, `apps/web/index.html:10`, `apps/web/src/tv.ts:98-107` | Keep it (§3.4) |
| Web room route `/r/<id>` | `apps/web/src/route.ts:5-6`, `apps/web/src/main.ts:28` | The invite link's path; the private-room key goes in its fragment (§3.2) |
| Site share record in `sessionStorage["omega.share"]` | `apps/web/src/share-token.ts:17-41`, `apps/web/src/room.ts:432` | Unchanged |
| Extension: room dropdown from `GET /rooms`; share token found by the room id in an open tab's URL | `apps/extension/src/rooms.ts:30-49`, `apps/extension/src/share-token.ts:43-48` | Private rooms are not in the list (§3.5) |
| Layout v1, `FurnitureSchema` / `RoomLayoutSchema` are non-strict `v.object` | `packages/shared/src/layout.ts:107-112,152-156` (OME-271 branch) | `layout-set` needs strict input variants (§5.3) |
| `rooms` table `(id, title, created_at, layout, embed)`, `RoomStore` with insert / setLayout / setEmbed | `apps/server/migrations/0001-rooms.sql`, `apps/server/src/store/rooms.ts:39-49` (OME-277 branch) | Migration `0002` adds the M4-late columns (§1.4) |

## 1. `POST /rooms`: creation, limits, GC

### 1.1 Request and response

```
POST /rooms
Content-Type: application/json
{ "title": "Friday films", "visibility": "public" | "private" }

201 { "ok": true, "room": { "id": "k3v…26 chars", "title": "Friday films", "visibility": "private" }, "ownerToken": "<22 chars>", "inviteKey": "<22 chars, private rooms only>" }
4xx/503 { "ok": false, "error": { "code", "message", "retryAfterMs"? } }
```

- **The server picks the id** (§3.1). A client-chosen slug would let people squat names ("lobby2", "official", slurs) and would mark the room as public or private by its shape.
- **Error codes:** `invalid_body` (400), `payload_too_large` (413, body > 1 KB, read with `readBodyCapped` at `rate-limit.ts:125`), `rate_limited` (429 + `Retry-After`, ADR 0016 §4), `too_many_rooms` (503).
- **Origin:** the existing Host/Origin gate (`server.ts:89-91`) and CORS on `/rooms/*` (`http.ts:81-89`) already apply. Requests without an `Origin` header still pass, as today. They aren't a CSRF vector, and a script could create rooms without a browser anyway, so the buckets are the real control.
- **Every room starts from `DEFAULT_LAYOUT`** (ADR 0021). There is no "create with layout" body, so the creation path takes no large input.

### 1.2 Limits

| Limit | Value (server-private, ADR 0016 §1) | Why |
|---|---|---|
| Per key: creations | `KeyedLimiter(2, 1/600 s)`: 2 at once, then one every 10 min (≤ 8 in the first hour) | A person makes a room or two. A script on one address fills `MAX_ROOMS` only after about 2.5 days, and GC collects unused rooms after 1 h |
| Global: creations | `TokenBucket(10, 1/60 s)`: 10 at once, then one a minute | The bound against many-address floods, like the global share bucket (`http.ts:31-32`). At most about 60 rooms an hour |
| Failed bodies per key | Counted in the same per-key bucket (taken before parsing) | Malformed spam costs the same as a creation |
| `MAX_ROOMS` | **500 stored rooms**, counting pinned ones | One small box. At about 5 KB per idle room in memory (layout ~2 KB + `Room`), 500 rooms ≈ 2.5 MB. The DB stays under 2 MB |
| At the cap | **Refuse** with 503 `too_many_rooms`. **Never evict** | Evicting the oldest idle room would let an attacker delete other people's rooms by creating new ones |

Under the worst sustained flood the global bucket allows (60/h), never-joined rooms are collected after 1 h, so the steady state is about 60–70 abandoned rooms, well under 500. To fill `MAX_ROOMS`, an attacker must also **join** each room, which keeps it alive for 14 days. Joining costs a WS upgrade and a join on each room (per-key buckets `ws.ts:66-69`, ≤ 10 sockets per key `server.ts:42`), and the room only stays alive while the attacker keeps rejoining it once every 14 days. Accepted: the result is a full room table, not a broken site. Existing rooms keep working, the operator sees the 503s, and can delete rooms by CLI.

Creation limits sit in memory, so they **reset on restart** (a deploy). Restarts are rare, and the global bucket and the cap still bound the burst after one. Accepted (§4).

### 1.3 GC: when, and what is kept

| Room state | Rule |
|---|---|
| **Pinned** (seeded: `lobby`, operator-made) | Never collected. `owner_hash` is NULL, so the room is operator-managed and has no owner |
| Created, **never joined** | Deleted **1 h** after `created_at` |
| Created, **empty** | Deleted **14 days** after it last became empty (`last_active_at`) |
| Created, occupied | Never collected |

- **Sweep:** a `setInterval` every hour, plus one at boot. It is O(rooms) over the in-memory map, so at most 500 checks. It deletes the room from the DB in one transaction, then drops it from the in-memory maps. A room that someone is joining at that moment is not empty, so the sweep skips it. The sweep and joins both run on the one JS thread, so they can't race.
- **`last_active_at` is written only on transitions**: from 0 to 1 member and from 1 to 0 members. It is never written on every join, so the relay path stays free of the store (hosting research §2.4).
- **What is kept after deletion: nothing.** The row goes: id, title, layout, embed, owner hash and invite hash. There is no tombstone. With 128-bit random ids, a deleted id is never reissued in practice (§3.1), so no tombstone is needed to stop an old invite link from landing in a stranger's new room. Nightly backups hold deleted rows for up to 14 days (hosting research §2.5). The privacy note says so (§4.4).
- **Delete by the owner** (§2.2) and **delete by GC** share one code path, `removeRoom(room, reason)`: close every socket with `ROOM_CLOSED` (4004), which revokes their share grants through `depart` (`ws.ts:166`), drop the per-room buckets, delete the DB row, and remove the room from the map.

### 1.4 Storage (migration `0002`, on top of OME-277's `0001`)

```sql
ALTER TABLE rooms ADD COLUMN visibility     TEXT    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'));
ALTER TABLE rooms ADD COLUMN pinned         INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1));  -- rows from 0001 are seeds
ALTER TABLE rooms ADD COLUMN owner_hash     BLOB    CHECK (owner_hash IS NULL OR length(owner_hash) = 32);
ALTER TABLE rooms ADD COLUMN invite_hash    BLOB    CHECK (invite_hash IS NULL OR length(invite_hash) = 32);  -- private rooms only
ALTER TABLE rooms ADD COLUMN last_active_at INTEGER;  -- unix ms; NULL = never joined
```

No column records **who** created a room. There is no creator address, no key and no user agent (§4).

**All rooms stay in memory** (≤ 500). The upgrade lookup (`server.ts:96`) stays a `Map.get`. If the lookup read the DB lazily instead, every probe for an unknown id would cost a DB read before any limiter runs (§3.3).

## 2. Owner token

### 2.1 Shape, minting, storage on the server

- **Shape:** the share token's, 16 bytes from `crypto.getRandomValues`, base64url, 22 chars (`ws.ts:80-81`, `share.ts:6-13`). `OwnerTokenSchema` reuses the regex. `parseBearer(header)` is generalised from `parseShareAuthorization` (`share.ts:22-26`), with the same exact-length guard before the regex.
- **Minted once,** in the `POST /rooms` 201 body. It never appears in a URL, a snapshot, a broadcast or a log line. Like the share token, it is a bearer secret, so anyone holding it is the owner.
- **The server stores `SHA-256(token)`** (32 bytes) in `rooms.owner_hash`, never the token itself. The token holds 128 bits of entropy, so a plain unsalted hash can't be brute-forced, and a leaked DB or backup gives nobody ownership. The check: hash the presented token and compare it with `crypto.timingSafeEqual` against **that room's** hash. The lookup is by room id, never by token, so there is no `Map<token, …>` and no cross-room use.
- **No expiry.** Ownership lasts as long as the room, and GC already ends idle rooms. **No rotation in v1.** M5 could add it, but rotation only helps if a token leaks, and our transport rules make that unlikely.

### 2.2 What it allows (and what it doesn't)

| Action | Transport | Why |
|---|---|---|
| **Edit the layout** (`layout-set`) | WS, after `join { ownerToken }` | The editor lives in the room. The owner sees the result live with everyone else |
| **Rename** (`title-set`) | WS, same | Same place, same auth |
| **Delete the room** | `DELETE /rooms/:id` + `Authorization: Bearer <ownerToken>` | Works from outside the room (a "your rooms" list on the home page). Mirrors the share endpoint (`http.ts:116-126`): 404, then a failed-auth bucket per key, then 401 |
| Change visibility | **No** (fixed at creation) | Going from private to public would list a room whose members joined expecting privacy. Going from public to private can't hide a room that was already listed and joined. Create a new room instead |
| Share / seek / mute / kick | **No** | The owner is a regular member here. Host/DJ (P-A) and moderation (P-B) are separate proposals. The owner token is the natural anchor for them later, but adding them here would widen this contract |

**Owner auth on the socket:** `join` gets an optional `ownerToken`. If it matches, the server sets `ws.data.owner = true` and the snapshot carries `owner: true`. In a private room, a valid owner token also admits the owner without an invite key (§3.2). Otherwise, a **wrong token does not fail the join.** The member joins as a guest (`owner: false`), and the attempt is taken from a per-key failed-owner bucket (the shape of `failedShares`, `http.ts:27-29,64`). Repeated failures count toward the 4400 bad-message close. A failed join would only be a worse user experience for a stale token, and 128 bits make guessing pointless anyway. The bucket is just cheap hygiene.

**Several owners at once:** anyone holding the token is the owner, so two tabs or two devices can both edit. The last `layout-set` wins. Each one is a whole layout (§5.3), so the result is always valid.

### 2.3 Storage and transport on the client (vs ADR 0015 §7)

ADR 0015 §7's rules for the share token are: never in a URL, only in the holder's own response, kept in `sessionStorage` and cleared on leave. The owner token keeps **every one of those rules except `sessionStorage`**:

- **`localStorage["omega.rooms"]`**: `{ "v": 1, "rooms": { "<roomId>": { "ownerToken"?: "…", "inviteKey"?: "…" } } }`, at most 50 entries, oldest dropped first. It holds owner tokens and private-room invite keys (§3.2). It is Valibot-parsed on read, like the profile (`apps/web/src/profile.ts:36`). A share token is meant to die with the tab. An owner token must survive the tab, or "come back tomorrow and rearrange your room" is impossible. That is the whole point of ownership.
- **Removed** when `DELETE` succeeds, when the server answers 404 for that room (it was collected), and when the user clicks "forget".
- **Exposure:** same-origin script only. Our CSP has no inline script and no `eval` (`headers.ts:6-20`), and Trusted Types gets enforced in M4 (hosting research D2). The extension reads only `omega.share` (`apps/extension/src/share-token.ts`) and must not start reading `omega.rooms`. A contract-level constant `ROOM_SECRETS_STORAGE_KEY` documents that.
- **Never in the invite link.** The UI offers "Copy invite link" (`/r/<id>`, plus `#k=<inviteKey>` for a private room) and nothing else. There is no "owner link".

### 2.4 Recovery if it's lost

**None, deliberately.** Without accounts, nothing can prove that someone is the owner except the token. Any "recover" path (email, a security question, an operator asking "is this you?") is either an account system or a social-engineering hole. A lost token leaves an **ownerless room**. It keeps working as a normal room, and GC collects it 14 days after it goes idle. The fix for the user is to create a new room.

Optional M5 nicety, not in this contract: an "owner key" box in settings that shows the token for copy and paste to another device. It is shown as text, never as a link, and stays out of the URL bar and history.

## 3. Private rooms (P-C)

### 3.1 Unguessable ids

- **Id = 16 random bytes encoded as lowercase RFC 4648 base32 without padding = 26 chars of `[a-z2-7]`.** That gives 128 bits and fits `RoomIdSchema` (`room.ts:14`) unchanged, so the web route (`route.ts:5-6`), the WS path (`server.ts:36`), the extension's tab-URL parser and the DB `CHECK` (≤ 32) all accept it as is.
- **Public and private created rooms use the same id format**, so the shape of an id reveals nothing about the room. Only seeded rooms keep slugs (`lobby`).
- Collisions: 2⁻¹²⁸ per pair. The insert is a plain `INSERT` (no `OR REPLACE`), so a collision would be a primary-key error and a retry, never an overwrite.
- **An unguessable id is not enough to keep a room private.** ADR 0015 §8 settled that "room ids are not secret": the Twitch SDK forwards `location.href` to Twitch as `referrer` (ADR 0014; `apps/web/src/share-token.ts:18`). `Referrer-Policy` can't prevent that, because the SDK reads the URL itself. Any private room that ever plays a Twitch stream hands its id to Twitch. We would also have to trust every future SDK not to do the same.

### 3.2 Invite links: the id plus an invite key in the fragment

- **Invite link = `https://<origin>/r/<id>#k=<inviteKey>`**. `inviteKey` has the owner-token shape: 16 random bytes in base64url, 22 chars. It is minted at creation for private rooms only and returned in the `POST /rooms` body. The server stores only `SHA-256(inviteKey)` in `rooms.invite_hash`.
- **Why a fragment:** browsers never send it to the server and never put it in a `Referer`. The one thing that does see it is script that reads `location.href`, and that is exactly the Twitch SDK. So **at boot, before anything else runs**, the site reads `#k=` with a strict parser (exact length, `[A-Za-z0-9_-]`), saves the key, and calls `history.replaceState` to drop the fragment (`apps/web/src/main.ts:28`, beside `roomIdFromPath`). Provider SDKs load only after `join`, once a snapshot has an embed, so they always see the bare `/r/<id>`. A unit test pins the order, and the QA suite checks Twitch's `referrer` parameter in a HAR.
- **The server checks it at `join`:** `join { inviteKey? }`. For a private room, the join needs a matching `inviteKey` or a valid `ownerToken` (§2.2). Otherwise it is refused with `error invite_required`. Like `nickname_taken` (ADR 0016 §4), the socket stays open and unjoined and the join timeout still applies. Failed keys come out of a per-key failed-invite bucket and count toward the 4400 bad-message close. Before `join` succeeds, the socket gets no snapshot and no broadcasts, so a refused peer learns only that the room exists. An id leaked to Twitch is therefore harmless.
- **Kept on the client** in the same `localStorage["omega.rooms"]` record as owner tokens (§2.3), so the bookmark `/r/<id>`, which no longer has its fragment, still works tomorrow. "Copy invite link" rebuilds the full link from the stored key, so any member who holds the key can forward it, just as they could forward the original link.
- **Revocation is cheap (owner action, M4-late or M5):** `invite-rotate` mints a new key and overwrites `invite_hash`. Old links stop working for new joins, and members already in the room stay. Unlike re-keying the room id, it touches one column.
- **What a link holder can do** in a private room is exactly what a guest can do in a public room. Every M3 limit applies as is. Private doesn't mean trusted.
- **This reverses part of ADR 0015 §8** ("tokens and invites never go in URLs"). ADR 0028 must record the narrow exception: invite keys only, only in the fragment, removed before any third-party script runs, and never sent to our server in a URL. Owner and share tokens keep the full rule.

### 3.3 Enumeration

| Probe | Today | M4 |
|---|---|---|
| `GET /rooms` | Lists every room (`http.ts:95-99`) | Lists **public rooms only**. Private rooms aren't counted or hinted at |
| WS upgrade to `/rooms/<guess>/ws` | 404 vs upgrade, **before any limiter** (`server.ts:96-97`) | With 128-bit ids, guessing is pointless (2¹²⁸ ids, ≤ 500 rooms). Still **move the per-key upgrade limiter (`ws.admitUpgrade`) before the room lookup**, so 404 probes cost a token like real upgrades. That also bounds log and CPU noise |
| `join` to a private room with a guessed key | — | `invite_required`, a failed-invite bucket per key, 4400 after repeats. 2¹²⁸ keys |
| `POST /rooms/<guess>/share` | `room_not_found` 404 before auth (`http.ts:116-117`) | Same answer. With the 128-bit argument this is fine. No change, so the extension keeps its error message |
| `DELETE /rooms/<guess>` | — | 404, then auth. The failed-auth bucket covers both |
| Timing | `Map.get` | No meaningful timing oracle |

### 3.4 Link leaks and Referrer-Policy

| Channel | Risk | Decision |
|---|---|---|
| **Referer to the providers** (iframe `src`, SDK scripts) | A full `/r/<id>` path in a `Referer` would hand the id to YouTube, Twitch or Vimeo | **Headers are already safe:** `strict-origin-when-cross-origin` sends only the origin cross-origin (`headers.ts:46`, `index.html:10`, iframe attribute `tv.ts:98-107`). **Do not switch to `no-referrer`:** YouTube refuses embeds without a referrer (`tv.ts:98`), and Vimeo's domain check reads the referrer's origin (`tv.ts:106`). Add a header test that pins the value |
| **Twitch SDK `referrer=` parameter** | It reads `location.href` and sends the room id to Twitch (ADR 0015 §8) | **Accepted for the id**, because the id grants nothing (§3.2). The invite key is gone from `location.href` before the SDK loads. QA checks this in a HAR |
| Referer on outbound links (future footer link, AGPL "Source") | Same | Covered by the same policy. Also add `rel="noreferrer"` on external `<a>` elements |
| Search engines | A private URL posted somewhere public gets indexed | `X-Robots-Tag: noindex, nofollow` on `/r/*` responses (server `static.ts`/`headers.ts`) |
| Browser history, sync, screenshots, chat paste | The user shares the link | Inherent to link-based privacy. The UI copy says "anyone with this link can join" |
| Server logs | Caddy access logs record paths | Hosting research D6: access log off or ≤ 7 days, and the app never logs paths with ids |
| Extension | The share flow sends the room id to our server only | No new exposure |
| The `omega.share` record | Holds the room id, in `sessionStorage` | Same origin, same as today |

### 3.5 List and extension

- `GET /rooms` returns at most `MAX_LISTED_ROOMS` (100) **public** rooms, **sorted by `memberCount` desc, then `created_at` desc**. Pinned rooms always come first. That stops a flood of empty rooms from pushing the lobby out of the list.
- **The extension's dropdown** comes from `GET /rooms` (`apps/extension/src/rooms.ts:30-49`), so private rooms are missing from it. The share token is already found through any open room tab (`share-token.ts:43-48`). Extension change: **add rooms from open room tabs to the dropdown** and prefer them. Those tabs are exactly where the user can share. This is an extension issue, owned by the Extension Engineer.

## 4. Abuse controls that need persistence

### 4.1 What we have, and what restarts lose

Every abuse control is an in-memory bucket keyed by client address: joins, upgrades, members per key, shares, failed shares, chat, sit, control, 4029/4400 (`ws.ts:52-72`, `http.ts:24-35`, `rate-limit.ts:48-81`). A restart (a deploy) resets them. Hosting research §2.2 rules out storing client keys or IPs on disk.

### 4.2 Options

| Option | What is stored | Personal data? | Value against our threats | Verdict |
|---|---|---|---|---|
| **A. Persist nothing about people** (status quo) | Room rows only | No | Restarts are rare and planned. A flood after a restart meets the same buckets within seconds | **Recommended for M4** |
| B. Hashed-key bans with a TTL, pepper on disk | `HMAC(pepper, key)`, `expires_at` | **Yes.** Pseudonymised: the pepper sits next to the data, and 2³² IPv4 addresses can be hashed in seconds. GDPR Art. 4(5), Recital 26; IPs are personal data (CJEU C-582/14 *Breyer*) | Low. Nobody decides the bans: we have no moderators, and auto-bans on 4029/4400 punish everyone behind a shared address (CGNAT, campus, mobile) | No |
| C. Same, pepper in memory only | As B | Arguably anonymous once the pepper is gone, but then bans also vanish on restart | None over A: persistence was the only reason | No |
| D. Owner-scoped bans (P-B "kick + ban for N min") | In-memory per room | Not on disk | Real, once P-B exists | Later, with P-B, **in memory** |
| E. Non-personal content controls | A blocklist of room-title words in the repo or config, and room rows flagged by the operator | No | Medium: titles are the only user text that persists and gets listed | **Yes, small:** an operator CLI `rooms delete <id>` and an optional title blocklist in config |

### 4.3 Recommendation

1. **M4 persists nothing about abusers (option A).** No address, hashed address, key or user agent goes on disk, and no creator is recorded on a room row. Every limiter stays in memory.
2. **An operator break-glass, specified but not built:** if a sustained, targeted attack ever needs a ban that survives restarts, add a `bans(key_hmac BLOB PRIMARY KEY, expires_at INTEGER NOT NULL)` table. It holds `HMAC-SHA256(BAN_PEPPER, clientKey)`, where `BAN_PEPPER` is a Paperclip secret passed as an env var and never stored in the DB. The **TTL is at most 7 days**, purged by the hourly sweep. Bans are **set only by the operator** through the CLI, never automatically, and the privacy note gets updated before first use. It would need its own small ADR and issue.
3. **Edge rate-limiting first:** if floods become real, Caddy rate limits or a DDoS-shielding proxy (hosting research D3) are cheaper and store nothing extra in our system.

### 4.4 GDPR and privacy implications (EU host)

- **In-memory address processing** for rate limiting is still processing. The lawful basis is legitimate interest, Art. 6(1)(f), with network and information security explicitly named in Recital 49. Retention: the lifetime of the process, at most 1024 keys per limiter (`rate-limit.ts:54`), and never on disk.
- **Persisted data** is rooms: id, title, layout, embed, visibility, timestamps, owner hash. **The owner hash is not personal data.** It is a random value tied to a room, not to a person. **A title can be personal data** if a user types a name into it. It is erased by owner delete and by GC, and stays in backups for at most 14 days.
- **A privacy notice is needed** before the hosted launch: what we process (addresses in memory, room data on disk), why, the retention periods (process lifetime; GC 1 h / 14 d; backups 14 d; access logs off or ≤ 7 d), no cookies or tracking, and no accounts. Data-subject requests: we can't link room data to a person. The owner can delete their room, and the operator can delete any room on request. This is a small web issue (a static page) plus an operator line in `docs/ops/`.
- **Option B** would add a pseudonymised identifier to the disk, a retention duty, and a notice entry. It is not worth it until a real incident shows that it's needed.

## 5. Contract sketch (`packages/shared`)

### 5.1 New constants

| Constant | Value | Enforced by |
|---|---|---|
| `ROOM_TITLE_MAX_LENGTH` | 32 UTF-16 units after NFKC | `RoomTitleSchema` |
| `ROOM_SECRETS_STORAGE_KEY` | `"omega.rooms"` (owner tokens + invite keys) | Site; the extension must not read it |
| `MAX_CREATE_BODY_BYTES` | 1024 | Server body cap, site |
| `CLOSE_CODES.ROOM_CLOSED` | 4004 | Server after delete or GC. Client action: **stop**, show "this room was closed" |

`MAX_ROOMS`, the creation buckets and the GC ages are **server-private** (ADR 0016 §1). Clients learn about them only through `too_many_rooms`, `retryAfterMs` and `4004`.

### 5.2 HTTP

```ts
RoomTitleSchema      = NFKC → trim → 1..ROOM_TITLE_MAX_LENGTH, nickname rules (no bidi/zero-width/control, mark-run ≤ 2, single script)
RoomVisibilitySchema = v.picklist(["public", "private"])
CreateRoomRequestSchema  = v.strictObject({ title: RoomTitleSchema, visibility: RoomVisibilitySchema })
OwnerTokenSchema     = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{22}$/))   // same shape as ShareTokenSchema
InviteKeySchema      = same shape; inviteKeyFromHash(hash) → InviteKey | null (strict `#k=` parser, never throws)
CreateRoomResponseSchema = v.variant("ok", [
  v.object({ ok: v.literal(true), room: v.object({ id: RoomIdSchema, title: RoomTitleSchema, visibility: RoomVisibilitySchema }), ownerToken: OwnerTokenSchema, inviteKey: v.optional(InviteKeySchema) }),
  v.object({ ok: v.literal(false), error: v.object({ code: v.picklist(["invalid_body", "payload_too_large", "rate_limited", "too_many_rooms"]), message, retryAfterMs: v.optional(RetryAfterMsSchema) }) }),
])
DeleteRoomResponseSchema = { ok: true } | { ok: false, error: { code: "room_not_found" | "unauthorized" | "rate_limited", … } }
RoomSummarySchema += { title: v.optional(RoomTitleSchema) }   // optional: an M4-early server sends none
```

Titles reuse the nickname pipeline (ADR 0016 §2): NFKC, refuse rather than strip, and a single script. A title is user text that gets **listed publicly**, so it gets at least the nickname's rules. A `GET /rooms` body grows by at most 100 × ~45 B ≈ 4.5 KB, to about 10.5 KB. Bump `MAX_LISTED_ROOMS`' comment, not its value.

### 5.3 WebSocket

```ts
// client → server (strictObject, like every client frame)
join      += { ownerToken: v.optional(OwnerTokenSchema), inviteKey: v.optional(InviteKeySchema) }
layout-set  { type: "layout-set", layout: RoomLayoutInputSchema }   // owner only
title-set   { type: "title-set",  title: RoomTitleSchema }          // owner only

// server → client
snapshot       += { owner: v.optional(v.boolean()) }   // only in the joiner's own snapshot
layout-changed   { type: "layout-changed", layout: RoomLayoutSchema, by: MemberIdSchema }
title-changed    { type: "title-changed",  title: RoomTitleSchema,  by: MemberIdSchema }
error codes    += "not_owner", "invite_required"
```

- **`RoomLayoutInputSchema`**: the same checks as `RoomLayoutSchema` (ADR 0021 §3), but built on **`strictObject`** for the layout and each piece. ADR 0021's schemas are non-strict `v.object` (`layout.ts:107-112,152-156` on the OME-271 branch), which is right for server → client and wrong for a client frame (ADR 0016 §6). Build both from one shared entries object so the rules can't drift.
- **`layout-set` is a whole layout**, not a diff. v1 has no item ids (ADR 0021 §1), so a diff would need them. A whole layout is idempotent, so "last write wins" is always valid.
- **Seats on a layout change (ADR 0021 consequence 3):** the server **keeps `seats[]` as is**. A valid layout always has exactly `SEAT_COUNT` seat cells, so every seat index stays valid, and clients draw seated avatars at the new `i`-th seat cell. This needs no seat messages and leaves nobody unseated. If an owner reorders pieces, avatars move to other chairs, which is cosmetic. The alternative, unseating everyone, costs up to 25 `seat-changed` frames per edit and punishes viewers for the owner's editing.
- **Server order for `layout-set`:** strict parse (already done at the boundary) → `owner` check (`not_owner`, counting toward 4400) → a per-socket layout bucket (2 at once, then 1 every 2 s, server-private) → a no-op check (same JSON as the current layout, so nothing to do) → `RoomStore.setLayout` (one synchronous write, a few tens of µs) → publish `layout-changed`. The write happens only on this message, never on `control` or `chat` (hosting research §2.4).
- **Sizes vs the caps:**

| Frame | Worst case | Cap | Headroom |
|---|---|---|---|
| `layout-set`, 32 pieces | 32 × `{"kind":"bookshelf","col":9,"row":9,"facing":"sw","variant":3}` (63 B) + commas + wrapper ≈ **2.1 KB** | `MAX_CLIENT_MESSAGE_BYTES` 4096 | ~1.9 KB. Pin it with a test |
| `join` + `ownerToken` + `inviteKey` | ~170 B | 4096 | — |
| `title-set` | 32 units of 4-byte UTF-8 ≈ 160 B | 4096 | — |
| `layout-changed` | ≈ 2.2 KB | `MAX_SERVER_MESSAGE_BYTES` 16384 | — |
| `snapshot` with layout + `owner` | ADR 0021 worst case + ~15 B | 16384 | Unchanged |
| `POST /rooms` body | ~110 B | `MAX_CREATE_BODY_BYTES` 1024 | — |

- **Compatibility:** every addition is optional on the server → client side. Old clients strip `owner`, `title` and unknown message types fail their parse and get dropped. The site and server deploy together anyway. The new client messages are new variants, so an older server would answer `bad_message`. That can't happen in our one-origin deploy.

## 6. Perf and safety deltas

### 6.1 Perf

| # | Delta | Risk | Guard |
|---|---|---|---|
| P1 | Up to 500 in-memory rooms instead of 1 | Low: ~2.5 MB, `Map.get` lookups | Per-room maps become `WeakMap` or get deleted on removal (§0 leak). A test creates and deletes 1000 rooms and checks that the map sizes return to the baseline |
| P2 | `GET /rooms` filters and sorts ≤ 500 rooms per request | Low: ~µs. Cache the response body for 1 s if a load test shows it | Existing HTTP gate. No new budget |
| P3 | Hourly GC sweep | Negligible: O(500) | — |
| P4 | `layout-set` → one DB write + one ~2.2 KB pub/sub broadcast | Low: rate-limited to 1 every 2 s per owner | A test pins that `control`/`chat` never touch the store |
| P5 | **Web:** a `layout-changed` rebuilds the static furniture layer | Medium if done badly | Rebuild the batched static container **once per change**, never per frame. The frame and missed-vsync budgets (ADR 0017) are rerun on the web issue |
| P6 | **Bundle:** the create form, "your rooms" and the layout editor | Medium: the editor could be large | The **editor goes in a lazy chunk** (dynamic `import()` when the owner opens it). The initial chunk grows only by the create form and the schemas (< 2 KB gz). Measured on the web issue against the 200 KB budget |

### 6.2 Safety

| # | Delta | Where |
|---|---|---|
| S1 | Server-chosen 128-bit ids for every created room; no client slugs | server `POST /rooms` |
| S2 | Owner token: minted once in the 201 body, SHA-256 at rest, `timingSafeEqual`, looked up by room id | server, contract |
| S3 | `localStorage["omega.rooms"]` Valibot-parsed and capped at 50; owner tokens never in a URL; the extension doesn't read it | web, extension (negative test) |
| S4 | Private rooms out of `GET /rooms`; visibility fixed at creation; **join needs the invite key** (hash at rest), which travels only in the fragment and is stripped with `replaceState` before any SDK loads | contract, server, web |
| S5 | `ws.admitUpgrade` moves **before** the room lookup (`server.ts:96-102`) | server |
| S6 | Pin `Referrer-Policy` in a header test; `X-Robots-Tag: noindex, nofollow` on `/r/*`; `rel="noreferrer"` on external links | server, web |
| S7 | New client frames are `strictObject` (`RoomLayoutInputSchema`); owner-only checks before any write | contract, server |
| S8 | Room titles use the nickname rules, plus an optional title blocklist in config; listed titles are rendered as text only (no HTML sink) | contract, server, web |
| S9 | `ROOM_CLOSED` (4004) on delete or GC; the client stops reconnecting | contract, server, web |
| S10 | No personal data on disk: no creator, no address, no hash of one. A privacy notice before launch | server, web, ops |
| S11 | `MAX_ROOMS` refuses and never evicts; operator CLI `rooms list / delete` | server, ops |
| S12 | GC and owner delete share one `removeRoom` path that closes sockets, so grants are revoked before the row goes | server |

## 7. Proposed issue list (for the CEO)

Same shape as hosting research §6. Each engineering issue is TDD (failing-test commit first). Dependencies are shown with →. Assumes OME-271 (layout v1 contract) and OME-277 (SQLite store) have merged.

| # | Issue | Owner | Paths | Depends on |
|---|---|---|---|---|
| 1 | **Contract: room ownership, creation, private rooms + ADR 0028** (§5: create request and response, `OwnerTokenSchema` + `parseBearer`, `InviteKeySchema` + `inviteKeyFromHash`, `invite_required`, `RoomTitleSchema`, `RoomSummary.title`, `join.ownerToken`, `snapshot.owner`, `layout-set`/`title-set`, `layout-changed`/`title-changed`, `not_owner`, `ROOM_CLOSED`, `RoomLayoutInputSchema` from the same entries as `RoomLayoutSchema`, size tests) | Lead | `packages/shared/**`, `docs/adr/0028-*` | OME-271 |
| 2 | **Server: per-room state that can come and go** (the `http.ts:65-74`/`ws.ts:113-122` maps become `WeakMap` or get removed; `removeRoom` with 4004; upgrade limiter before the lookup, S5). Can start before #1 except the 4004 constant | Lead | `apps/server/src/{http,ws,server}.ts` | (#1 for 4004) |
| 3 | **Server: `POST /rooms` + `DELETE /rooms/:id` + migration `0002`** (ids, buckets, `MAX_ROOMS`, owner hash, list filter and sort, title blocklist config, `X-Robots-Tag`) | Lead (or implementer) | `apps/server/src/{http,config,headers}.ts`, `apps/server/src/store/**`, `apps/server/migrations/0002-*` | 1, 2, OME-277 |
| 4 | **Server: GC sweep + `last_active_at` transitions** | Lead (or implementer) | `apps/server/src/rooms-gc.ts` (new), `apps/server/src/store/**`, `room.ts` | 3 |
| 5 | **Server: owner and invite auth on join + `layout-set`/`title-set`** (`invite_required`, failed-owner and failed-invite buckets, layout bucket, store write, broadcast, seats kept) | Lead | `apps/server/src/ws.ts`, `room.ts` | 1, 3, OME-277's layout wiring |
| 6 | **Server: operator CLI** (`rooms list/delete/pin`) | Lead (or implementer) | `apps/server/src/cli.ts` (new), `docs/ops/` | 3 |
| 7 | **Web: create room + invite link + "your rooms"** (form, `localStorage["omega.rooms"]`, the `#k=` fragment read and stripped at boot before any SDK, copy invite link, list shows titles, `4004` handling, `rel="noreferrer"`) | Lead | `apps/web/src/{main,route,room}.ts`, `apps/web/src/room-secrets.ts` (new), `apps/web/src/home*.ts` | 1 (3 for e2e) |
| 8 | **Web: layout editor (lazy chunk) + live `layout-changed`/`title-changed`** (batched static layer rebuilt once per change; perf rerun) | Lead | `apps/web/src/editor/**` (new), `apps/web/src/layout*.ts` | 1, 7, the web layout issue from hosting research §6 #6 (5 for e2e) |
| 9 | **Web: privacy notice page + footer link** (beside the AGPL "Source" link, hosting research D9) | Lead | `apps/web/src/privacy*`, `apps/web/index.html` | — |
| 10 | **Extension: rooms from open tabs in the dropdown** (private rooms; never read `omega.rooms`, with a negative test) | Extension Engineer | `apps/extension/src/{rooms,share-token}.ts` | 1 |
| 11 | **Design: create-room form, owner chrome (edit / rename / delete), invite-link copy, "room closed" state** (not blocking: engineering ships plain UI first) | Creative Designer | `assets/**`, design docs | — (OME-276 already covers owner chrome) |
| 12 | **QA: rooms suite** (create limits and 429/503; private rooms absent from the list and the extension; a private join without the key is refused; the invite key is gone from `location.href` before the Twitch SDK loads (its `referrer=` in a HAR); owner token never in a URL, request line or broadcast, checked in the HAR / WS log; delete closes with 4004 and revokes share grants; GC with an injected clock; layout-set size and owner checks; enumeration probes rate-limited; perf rerun for the editor) | QA | `e2e/**`, `apps/server/test/**` (QA-owned files) | 3–8, 10 |

**Open questions for the CEO/board:**
- (a) Is this contract M4-late or M5? Recommendation: **M4-late**, after the hosted deploy, because creation without a real host has nobody to serve.
- (b) May anyone create rooms, or only invitees? Recommendation: anyone, with the limits in §1.2. Closed creation needs accounts or invite codes, which is a product change.
- (c) Is a 14-day idle GC acceptable product-wise? It's an easy knob.
- (d) Who handles takedown requests (an offensive title or room)? The operator CLI (#6) is the tool. Someone has to be named to use it.
