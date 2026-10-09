# ADR 0031 — Playback queue: add, remove, advance on `ended`, persisted in SQLite

**Status:** accepted (2026-10-09) · Lead · [OME-503](/OME/issues/OME-503) · plan [OME-499](/OME/issues/OME-499#document-plan) · builds on [ADR 0024](0024-generic-embeds.md) (generic tier), [ADR 0030](0030-owner-moderation.md) (control policy), research [m6-store-and-ended.md](../research/m6-store-and-ended.md) Part B (R1, [OME-501](/OME/issues/OME-501))

**Context:** Today a room shows one embed. A share replaces it, and when a video ends nothing happens. M6 adds a per-room queue: members line up videos and the room moves to the next one when the current one ends. This ADR records the `packages/shared` contract (C2). The server (S2 [OME-506](/OME/issues/OME-506)) and the site (W2 [OME-508](/OME/issues/OME-508)) build on it.

## Decision

### 1. Items and ids
- A **queue item** is `{ id, embed, by }`. `id` is a server-assigned opaque `QueueItemIdSchema` (1–32 of `[A-Za-z0-9_-]`). `embed` is an `AnyEmbed`: what the server's share parser made of a URL, never the raw string. `by` is the adder's member id, or null when unknown. There's no nickname: clients look the id up in `members` and show "someone" when that member has left.
- **The current embed is an item too.** Room state carries its id as `itemId`, and `embed-changed` carries the new one. Every share (`POST /rooms/:id/share`) and every advance mints a fresh id, so an `ended` or `queue-advance` aimed at what was current before can never touch what's current now. `itemId` is absent when `embed` is null and from pre-M6 servers.
- `queue` in room state is the **upcoming** items in play order, at most **`QUEUE_MAX` = 20**, with distinct ids, never including the current one. Absent from pre-M6 servers: read it as empty.

### 2. Frames
Client → server, all `strictObject`:
- `queue-add { url }`: the raw URL (≤ `MAX_URL_LENGTH`), run through **the same `canonicalizeAnyEmbed` call as a share**, with the same `GENERIC_EMBEDS` kill switch and own-host list (`EmbedPolicy`). Only the parsed embed is stored or broadcast. A refused URL gets `error: unsupported_url`.
- `queue-remove { itemId }`: drop an upcoming item.
- `queue-advance { fromItemId }`: manual next. It applies only while `fromItemId` is the current item, so two people clicking "next" at once skip one item, not two. It's the only way past a live or generic item.
- `ended { itemId, position }`: "my player reached the end of this item, here", see §4.

Server → client:
- `queue-changed { queue, by }`: the **whole** upcoming list after any change. `by` is who added, removed or advanced; null when an `ended` report advanced it. A full list (≤ ~26 KB with 20 generic items at the longest URL, ~3 KB with synced ones) is simpler than deltas, and a client can never drift out of step with it. The per-room add bucket bounds how often it's sent.
- `embed-changed` gains optional `itemId`.
- **`POST /rooms/:id/queue`** is the extension's "Add to queue" (X1 [OME-509](/OME/issues/OME-509)); it has no socket. Same body (`ShareRequestSchema`), bearer share token, parser, control-policy check and errors as `POST /rooms/:id/share`, plus `queue_full` (HTTP 409). It takes from the same member and room add buckets as the WebSocket `queue-add` (the member is the token's). Response: `QueueAddResponseSchema`, `{ ok: true, item }` or the share error shape.
- New errors: `queue_full`, `unsupported_url`. Reused: `rate_limited` (+ `retryAfterMs`), `control_owner_only`, `not_joined`.
- **`MAX_SERVER_MESSAGE_BYTES` goes from 16 KB to 64 KB.** A worst-case snapshot (25 members, full layout, a generic current item, 20 generic items at 1024-char URLs) is ~36 KB. The cap is a client parse bound, not a buffer; a typical snapshot stays a few KB.

### 3. Who may do what, and in what order
- `queue-add`, `queue-remove` and `queue-advance` follow the room's **control policy** (ADR 0030 §4), like `control` and shares: under `owner`, a non-owner gets `control_owner_only` and nothing changes. Under `everyone`, any member may remove any upcoming item, as anyone may already replace the current one.
- `queue-add` is checked in this order, and **nothing is written or broadcast until every check passes**: joined (`not_joined`) → control policy (`control_owner_only`) → the member's add bucket, **`QUEUE_ADD_MEMBER_BURST` = 3, then one per `QUEUE_ADD_MEMBER_REFILL_MS` = 10 s** → the room's add bucket, **`QUEUE_ADD_ROOM_BURST` = 10, then one per `QUEUE_ADD_ROOM_REFILL_MS` = 3 s** (both `rate_limited`) → parse (`unsupported_url`) → room (`queue_full`). The buckets come before the parse so a flood can't buy URL parsing. None of these errors count toward the 4400 malformed-frame close.
- A `queue-remove` or `queue-advance` naming an item that isn't there (removed, or already advanced) is **ignored without an error**: it's a race, not a mistake. Both still count against the per-socket frame limit (L1).
- `ended` is **not** subject to the control policy: it reports what the player saw, it doesn't ask for a change.

### 4. Advancing on `ended`
R1 found that every client's player fires "ended" at about the same time, and that none of the providers needs a quorum to be trusted. So **the first valid report advances**. A report is valid only if all of these hold; anything else is **ignored silently** (no error, no 4400 count):
1. the sender has joined;
2. `itemId` is the current item;
3. the current embed is synced and **not live** (`playbackCaps(embed).live` false). Live embeds never end (Twitch offline is often temporary) and generic embeds have no API (ADR 0024): both advance by `queue-advance` only;
4. **debounce:** the item has been current for at least **`QUEUE_ENDED_DEBOUNCE_MS` = 3 s**. A broken embed that ends at once can't run through the whole queue in a burst;
5. `position` is within **`QUEUE_ENDED_TOLERANCE_S` = 5 s** of the server's room clock estimate (`position + (now − at) / 1000 × rate` while playing, `position` when paused). This drops reports from before a seek and from a local-only seek by someone who can't control the room (R1 B3), without a `rev` on the wire.

After the first valid report the item id is spent: later reports for it fail rule 2. If the queue is empty, a valid `ended` changes nothing (the room stays on the finished item, as today), and neither does `queue-advance`.

**Client rule** (web, not wire; R1 B2): send `ended` at most once per `itemId`, when the adapter emits `state: "ended"`, the player isn't in an ad, the provider's current video id is the item's (YouTube end-screen clicks), and the embed isn't live. Vimeo must not set `loop` (it suppresses `ended`).

**Accepted risk:** under the `owner` policy a member could forge an `ended` that passes rule 5 and skip the current item early. The damage is one skipped item at most every 3 s, the owner can kick, and it's no worse than what everyone may do under `everyone`. Checking against a server-known duration (R1 rules 5–7) would need the duration on the wire from a client too, so it doesn't stop a forger either. A **server fallback timer** for rooms where nobody reports (all tabs throttled) needs that duration; it is **out of scope for M6**. Manual next covers it.

### 5. What an advance does
In one synchronous step: remove the first upcoming item, make it current with a fresh `rev`, persist, then publish on the room topic — **`embed-changed { embed, by: null, playback, itemId }` first** (it starts the players, so it's on the spread's critical path), then `queue-changed { queue, by }`. A synced item starts with a `load` state (`playing: true`, `position: 0`). **A generic item gets `playback: null` and stays click-to-load for every viewer** (ADR 0024): becoming current never loads its iframe on its own. A share does not touch the queue; it replaces only the current item.

### 6. Persistence: SQLite migration `0003`
The queue survives a restart, like the room's current embed (`rooms.embed`, migration 0001). S2 adds `apps/server/migrations/0003-queue.sql`:

```sql
CREATE TABLE queue_items (
  room_id  TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  id       TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 32),
  position INTEGER NOT NULL,           -- play order within the room
  embed    TEXT    NOT NULL,           -- AnyEmbedSchema JSON, Valibot-parsed on every read
  PRIMARY KEY (room_id, id)
) STRICT;
ALTER TABLE rooms ADD COLUMN item_id TEXT;  -- the current embed's item id; NULL with no embed
```

- **No `by` column.** An item restored after a restart has `by: null`. Member ids die with the socket anyway, and nothing on disk says who queued what (ADR 0028 §7).
- A row that fails to parse on read is dropped and logged by room id only, as for `rooms.embed`.
- Writes follow the existing rule: store first, then change memory and broadcast; if the write fails, nothing changes. Each add, remove or advance is one small transaction, bounded by the add buckets.
- Room deletion (owner or GC) deletes its items (`ON DELETE CASCADE`; the connection enables `foreign_keys`, or the delete path removes them in the same transaction).

### 7. Budget
**Advance spread ≤ 1.5 s**: from the server publishing `embed-changed` for an advance to the last of 8 clients' players playing the new item, p95 over Q1's runs, per synced provider. It's looser than the 500 ms play/pause/seek spread because a new item means a fresh player load. Generic items are excluded: they wait for a click. Q1 ([OME-510](/OME/issues/OME-510)) adds the row to `docs/perf-budgets.md` together with the perf metric that measures it (the perf report test needs a budget for every row); it is merge-blocking from then on.

## Consequences
- Old clients ignore `queue-changed` and the `itemId` fields (server frames strip unknown keys) and keep working with shares only.
- S2 owns the buckets, the checks in §3–§4, the migration and the advance; W2 owns the queue UI, `ended` reporting and the client rule; Q1 measures the spread.
- A shared play duration, the server fallback timer and per-item "added by" after a restart are left for later; each would need its own ADR.
