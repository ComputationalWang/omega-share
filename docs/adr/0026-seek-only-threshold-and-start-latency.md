# ADR 0026 — Seek-only threshold is 250 ms; resumes compensate learned start-up latency

**Status:** accepted (2026-10-08) · Lead · [OME-392](/OME/issues/OME-392) (found in [OME-377](/OME/issues/OME-377)) · amends `docs/research/m1b-youtube-sync.md` §2 and `docs/research/m2-twitch-vimeo-sync.md` (seek-only "500 ms threshold")

**Context:** The Sync budget in `docs/perf-budgets.md` is ≤ 500 ms spread **between clients**. Seek-only players (Twitch VOD, Vimeo with rates rejected) seeked only when *their own* drift from the room passed 500 ms. Two clients drifting opposite ways could sit ~1 s apart without either correcting. A headed M2-twitch-vod run held 524 ms for 5 samples (~1.3 s). Separately, every resume (paused → play) started > 1 s behind the room: the hard seek was compensated with the *while-playing* seek latency, which a resume never trains, and start-up from pause costs more. Both clients then hard-seeked ~3 s later on different ticks, causing a visible ~1 s jump.

**Decision:**
- `SEEK_ONLY_THRESHOLD_MS = 250` (`apps/web/src/sync.ts`), half the pairwise budget. Two clients each within it stay within budget of each other. The median-of-3 plus `STABLE_MS` still limits a player to one seek per ~1.25 s, so this can't become a seek storm faster than that.
- The sync loop keeps a second estimate, `startLatencyMs`, next to `seekLatencyMs`. It learns only from a seek + play issued while the player was `paused`. The first sample replaces the 0 prior, and later samples use the same EWMA. A hard seek on a stopped player (paused, cued, unstarted, ended) aims that far ahead. A seek on a playing or buffering player keeps using `seekLatencyMs`.
- Not learned: a cold join (cued/unstarted includes loading the media and would overshoot later resumes), a start that needed a re-sent `play`, and a start interrupted by a user intent or an ad.

**Consequences:** the first resume in a session still lands behind by the start-up latency, then corrects. Later resumes start on the room clock. If Twitch VOD seek-only oscillates at 250 ms on real networks (HLS rebuffer), raise it per mode in a new ADR. Do not quietly go back to 500, because that breaks the pairwise budget.
