# ADR 0056: Movie night contract (timed reactions, watching summary, start times, countdown, theatre)

**Status:** accepted (2026-10-21) · Lead · [OME-1625](/OME/issues/OME-1625) (part of Movie night, [OME-1616](/OME/issues/OME-1616))

**Context:** Movie night makes the watching itself the feature: reactions that land on the video's timeline and replay for late joiners, a recap card, "N watching" in the extension, a share that starts where you are, a shared 3-2-1, and a theatre layout. Everything below the waves depends on one contract, so all of it is in one issue and goes through one QA perf run. It rides the relay batching of [OME-1624](/OME/issues/OME-1624) (ADR 0050 amendment).

## Decision

### Timed reactions
- **Client:** `react {kind}`, where `kind` is one of `REACTION_KINDS` = heart | laugh | wow | clap (the Designer's glyph set, [OME-1641](/OME/issues/OME-1641)). The message is strict, so it has **no client time** and a `mediaMs` or `at` key is refused. It needs `join`. It spends from the per-member `emote` bucket and is **dropped silently** over it, like a walk: a reaction is a click, not a sentence, so a burst should not cause error toasts. It is also dropped silently when the room has no synced current item (none, or a generic one).
- **Server:** `reacted {memberId, kind, mediaMs}` to everyone, sender included. `mediaMs` is an integer in 0..`MAX_POSITION_S`×1000. **The server stamps it from its own playback clock** (`expected_position` at receipt, in ms), never from the client. It is an ordinary room relay, so it is coalesced into `batch` frames for clients that opted in.
- **Snapshot:** `reactions` (beside `room`, like `poll` and `conga`) holds the current item's reactions, oldest first, at most `REACTIONS_MAX` = 256. When the cap is reached the oldest is dropped. They are cleared when the current item changes (share, advance, `ended`). `peakMembers` is the most members in the room at once since the current item started; the recap card needs it, and a late joiner can't know it otherwise. After the snapshot the client keeps `max(peakMembers, members.length)` itself. Both are memory only: never stored, never logged, gone after a restart.
- Reactions are separate from `emote` (`EMOTE_KINDS`): emotes are avatar bubbles with no timeline, and keeping them separate lets the moments strip and the replay ignore emotes.

### Watching summary (`GET /rooms`)
- `RoomSummary.watchingCount` counts the members whose tab is visible (not `away`), so it is at most `memberCount`. It is optional, so rows from the TS rollback server still parse.
- `RoomSummary.nowPlaying?: {provider, id}` (`nowPlayingOf(embed)`) holds the provider and the video's id, **never a title or URL**. YouTube and Vimeo give the video id. Twitch gives the channel login (live) or `videos/<id>` (VOD). "videos" is a reserved Twitch login, so the two forms never collide, and the id is the path on twitch.tv. It is absent for an **unlisted Vimeo video** (one with a hash), because its id is what the hash protects, and for a generic embed.
- **CEO decision (OME-1616):** this is allowed because `GET /rooms` lists **public rooms only** (private rooms are never listed or counted, ADR 0028), and anyone can join a listed room and see its video. Exposing provider:id on the list adds no information an anonymous visitor can't already get by joining. A private room never appears, so its video never does either. The row is in the threat table (`docs/research/m4-rooms-threat-model.md` §3.3).

### Share start time
- `ShareRequest.startSeconds?` (body of `POST /rooms/:id/share` and `/queue`) is an integer in 0..`MAX_POSITION_S`, parsed on both ends. It is whole seconds, because that is what a page's `currentTime` or a `t=` parameter needs and a float would only invite precision games.
- A share starts the room there: the `load` playback state has `position = startSeconds`. A queued item carries `startSeconds` in the `QueueItem` until it becomes current, and in memory only, like `by` (no migration in the rollback window). Late joiners follow the room clock as always. The value is ignored for a live or generic embed.

### Countdown (shared 3-2-1)
- `control.countdown?: boolean`. With `playing: true` the server answers a `playback` whose **`startAt`** is server time `at` + `COUNTDOWN_MS` (3 s). It is ignored with `playing: false` and for a live embed.
- `PlaybackState.startAt?` is valid only on a play (`playing: true`, `action: "play"`) with `at ≤ startAt ≤ at + COUNTDOWN_MAX_MS` (5 s). The clock holds at `position` until `startAt`, then runs: `position + (t − startAt) / 1000 × rate`.
- **Why a new field and not `at` in the future:** `at` means "the time `position` was true", and every client and the server's own `ended` tolerance read it that way. A future `at` would silently change that meaning. An explicit, bounded `startAt` keeps `at` honest, lets the schema bound the delay, and is invisible to code that doesn't know it (a client that ignores it would only start 3 s early).

### Theatre furniture
- New kinds, as agreed with the Designer on [OME-1639](/OME/issues/OME-1639) and drawn in the lazy `furniture-v5` sheet:
  - `theatrerow` (object, ne/nw, 2×1, seats, 3 variants = riser step 0/1/2)
  - `curtain` (wall, se/sw: the facing picks the wall)
  - `bigscreen` (object, fixed, 1×1)
  - `aislelight` (floor, ne/nw, 1×1)
  - `carpet` (floor, fixed, 2×2)
- **"Exactly one tv" becomes "exactly one screen"**: `SCREEN_KINDS` = tv | bigscreen, `isScreen(kind)`. Anything the web keys on the TV (in-use glow, lights-down, console anchor) treats both the same. We did not make the big screen `tv` variant 1, because one kind's variants would then live in two sheets, and the web routes each kind to one sheet.
- A sitter's lift on a raised row is render-only (`seatLiftByColour` in the atlas meta), not contract.

### Frozen TS server
It ignores `react`, `control.countdown` and `startSeconds`, and never sends `reacted`, `reactions`, `peakMembers`, `startAt`, `watchingCount` or `nowPlaying`. Every new field is optional, so a client must work without them (PORTING.md "Deliberate differences").

## Consequences
- 1 client message, 1 server message, 2 snapshot keys, 2 summary keys, 1 playback key, 1 share/queue-item key, 5 furniture kinds, and 3 constants (`REACTIONS_MAX`, `COUNTDOWN_MS`, `COUNTDOWN_MAX_MS`).
- **Frame size:** the worst-case snapshot is now **64,670 bytes** against the 65,536 cap. It has 25 members with 64-char ids, a full queue of longest generic URLs with start times, a full layout, 256 reactions, a poll and a 12-long conga (`queue-contract.test.ts`). Real member ids are shorter, but the headroom is under 1 KB. A future snapshot key must shrink something else or raise the cap.
- Reactions are relays: perf rides OME-1583's batching. QA's reaction-burst row (Pixel 7, walk25) is the gate for the server slice.
- Follow-ups: server [OME-1632](/OME/issues/OME-1632) (timeline + `reacted` + snapshot), [OME-1633](/OME/issues/OME-1633) (`watchingCount`, `nowPlaying`, `startSeconds`), [OME-1634](/OME/issues/OME-1634) (countdown); web OME-1628–1631; extension OME-1636/1637.
