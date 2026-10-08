# ADR 0027 — Seek-only players park instead of seeking while playing; the Twitch clock reads pushes as they arrive

**Status:** accepted (2026-10-08) · Lead · [OME-396](/OME/issues/OME-396) (found in [OME-377](/OME/issues/OME-377)) · amends [ADR 0026](0026-seek-only-threshold-and-start-latency.md)

**Context:** ADR 0026 lowered the seek-only threshold to 250 ms. On real Twitch VODs the sync loop then re-seeked almost every second: steady pairs flipped sign each sample, `afterPlay` held 777 ms, and a pause caught the two players 592 ms apart. A probe of the bare Twitch embed (a 10 ms `<video>.currentTime` log inside the iframe, a `message` log in the page) found three causes:

1. **Our Twitch clock read 250–500 ms behind.** The SDK's `getCurrentTime()` is a cache updated by the iframe's `UPDATE_STATE` pushes, about every 1.06 s. A periodic push carries a `currentTime` 196–211 ms old. A push right after play or seek is fresh, and a paused value is exact. The adapter only noticed a push on its next 4 Hz tick, which added 0–250 ms. A perfectly synced client measured −250 to −500 ms, which is always over 250 ms.
2. **A seek while playing lands on its target, but the stall before it plays again is 0.4–2.65 s** (8 seeks). No single learned latency can aim that within ±250 ms, so every correction re-rolled a ±1 s error.
3. **Seeking while paused and playing at the right moment lands −53 to −80 ms** (8/8, including 15 s+ jumps). A plain resume of buffered content lands within −5 to −27 ms.

**Decision:**
- **Twitch clock (`apps/web/src/player/twitch.ts`):**
  - The adapter reads the SDK cache on every `message` whose `source` is our player's iframe, so the reading is timed when the push arrives. The SDK's own listener runs first.
  - A reading taken while Playing gets `PUSH_LAG_MS = 200` added.
  - If a reading is up to 400 ms above the previous reading carried forward, the lower of the two wins. This drops the +200 ms overshoot of a fresh push. A bigger jump is taken as is.
- **Seek-only parks (`apps/web/src/sync.ts`):**
  - Drift above `SEEK_ONLY_THRESHOLD_MS` (250), or a hard seek on a playing or buffering player, or on a paused player more than 250 ms from the room, is corrected by a **park**. The park seeks to `room + PARK_LEAD_MS (1 s) + start-up latency` while paused, then plays on the 4 Hz tick where the room clock is within half a tick of that point.
  - The unpark trains `startLatencyMs` through the EWMA. It is never taken whole, so one load stall can't make later parks aim far ahead.
  - Fine and burst modes still seek while playing.
- **Seek-only resume:** a paused player within 250 ms of the room just plays. It is already at the room position, and a seek would drop its buffer: on Twitch, seek+play resumes landed 300–570 ms behind. A cold join (cued/unstarted) still seeks and plays, as before.
- **Paused pair:** a paused player more than `PAUSED_THRESHOLD_MS = 250` from the room re-seeks in every mode, instead of 1000 ms. That's half the pairwise budget. A paused seek lands exactly and shows nothing.
- **No longer lead for far jumps.** A paused Twitch seek outside the buffer doesn't preload. After a ~280 s room seek, a 1 s lead landed 348–491 ms behind and a 2 s lead landed 708–784 ms behind. The second, near park lands it either way.

**Consequences:**
- A seek-only correction freezes that viewer for about 1 s, then plays in step. After a room seek on Twitch that is two parks, about 4 s in all, with both clients landing alike.
- Headed `e2e:real` M2-twitch-vod passed 6/6 across the final runs, with `pausedDiffMs` 0 every time and held spreads mostly ≤ 140 ms.
- `PUSH_LAG_MS` is an observed property of Twitch's embed. If Twitch changes its push cadence, the steady drift readings in `e2e/real` will show it.
- The Twitch adapter now needs a `messages` subscription (the mount passes `window`'s `message` events). Unit tests pass a fake.
