# ADR 0048 — Real Twitch live play-from-live is recorded, not held to 500 ms

**Status:** accepted (2026-10-13), [OME-1057](/OME/issues/OME-1057); amends the real-provider clause of [ADR 0045](0045-late-player-readiness.md). It does not settle board question B1 ([ADR 0014](0014-twitch-and-vimeo-players.md)).

**Context:** `M3-twitch-gate` asserted a play spread of at most 500 ms on a real mature-gated live channel. In 12 runs on main@eb38900, 3 missed it with 709–913 ms. In those runs the pause still arrived within 60–74 ms, so the room's control reached both players on time. The slow player then ran Twitch's own live-edge reload after our `play()` (`Ready → Buffering → seek → play`, about 750 ms later). A live embed has no seek and no rate (ADR 0014 §3), so the web client can't shorten that reload. Research M2 §B1 already concluded that the 500 ms budget can't apply to real live, and `M2-twitch-live` asserts only a 2 s sanity bound.

**Decision:** This is not a product fix. It is a test-policy exception for real Twitch live play-from-live only.
- Real-provider tests on Twitch live still hold pause spread to ≤ 500 ms. Pause goes through our relay and the adapter's `pause()`, which we control.
- Real play-from-live spread is recorded in the evidence JSON and asserted only below 2 s (`LIVE_PLAY_SANITY_MS`), as `M2-twitch-live` already does.
- The merge-blocking Sync row in `docs/perf-budgets.md` (`sync.spread.twitch-live`, fake SDK, upper median of 4 rounds) stays ≤ 500 ms. It still guards our command path, including the OME-170 / OME-500 resend.

**Consequences:** A real live run where one viewer resumes up to 2 s late passes. A miss over 2 s, or any pause miss, still fails and carries both viewers' traces. A run where a player never pauses (OME-1057 run 8) is a separate failure and is tracked on its own. If the board answers B1 with a different live bound, that answer replaces this one.
