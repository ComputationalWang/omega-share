# ADR 0019 — `status { catching }` is advisory and never pauses the room

**Status:** accepted (2026-09-30) · contract [OME-213](/OME/issues/OME-213), server and web [OME-101](/OME/issues/OME-101) · research `docs/research/m3-threat-model.md` §7.7 · builds on ADR 0016 and ADR 0018

**Context:** A member whose player stalls (buffering, a slow network, an ad) already sees an hourglass on their own avatar (`apps/web/src/controls/catchup.ts`). Others can't see it, so they chat about a scene that member hasn't reached yet. We want the room to see who is catching up. Many watch-party tools do more: they pause everyone until the slowest member catches up.

## Decision

### 1. Wire contract (`packages/shared`)

| Direction | Message | Notes |
|---|---|---|
| client → server | `status { catching: boolean }` | `strictObject`. Needs `join` (`not_joined` otherwise). |
| server → room | `member-status { memberId, catching }` | Published to every member, the sender included. |
| server → joiner | `snapshot.room.members[].catching?: boolean` | Also on `member-joined`. Absent means `false`. |

`catching` lives on `MemberSchema` as an optional field, so a late joiner sees the current state without a replay. Old servers never set it. An old client's `v.variant` rejects the unknown `member-status` type and drops that frame, which is harmless. The site and server ship together (ADR 0015), so only a stale tab is affected.

### 2. Advisory only

`catching` is **display state**. The server never pauses, seeks or slows the room because of it, and no client acts on another member's flag except to draw it. Why:

- **Abuse:** a pause-on-stall rule lets one member (or a script that sends `catching: true` forever) freeze the room for everyone. The only defence would be heuristics about whose stall is "real". The server can't verify a player's state, so every such heuristic can be gamed.
- **Fairness at 25 members:** someone on a bad connection is almost always stalling. Pausing for them makes the room unwatchable for everyone else. They can still catch up by themselves: the sync controller already chases the room's position (ADR 0002, ADR 0013).
- **Live embeds** have no position to wait for.
- **Simplicity:** `PlaybackState` stays owned by `control` alone. Adding `status` doesn't touch the playback state machine or `rev`.

If a room later wants "wait for everyone", it becomes a host/DJ feature (threat model P-A) with an explicit, rate-limited `control`. It won't be a side effect of `status`.

### 3. Sending and limits

- **Client:** send only when the value changes, and only after it has held for `CATCHUP_SHOW_MS` (500 ms, web-private). The same debounce drives the local hourglass, so seek and buffering blips never go on the wire. On reconnect, the fresh join starts at `false`. Send `true` again if the player is still stalled.
- **Server:** `status` passes **L1** (every frame, ADR 0018). Over L1 it is dropped with `rate_limited` and `retryAfterMs`, like any frame, and it counts toward the 4029 streak. It has **no bucket of its own** and so no second `rate_limited` source. Instead, the server treats it as state: it stores the latest value and publishes `member-status` only when the value changes, **coalesced on the trailing edge to at most one per member per second**. The final value is always delivered. A flipping client costs the room at most 1 frame/s, and L1 bounds its own traffic. The coalescing numbers are server-private, like the other rate numbers (ADR 0016 §1).
- A member who leaves takes the flag with them (`member-left`). No `member-status` is sent.

## Compatibility

- `members[].catching` is optional, so snapshots from either side of the change still parse. Old clients strip it.
- An old server answers `status` with `bad_message`. The site and server deploy together, so this is not a real case.
- Until OME-101 lands, the server accepts `status` and ignores it, and the web ignores `member-status`, so `bun run check` stays green between the two halves.

## Consequences

- OME-101 (server): store `catching` per member, include it in `snapshot`, trailing-edge 1/s coalescing, tests with an injected clock.
- OME-101 (web): send on change after the debounce, and draw other members' hourglass from `member-status` and the snapshot.
- Contract tests: `packages/shared/test/catching-contract.test.ts`.
