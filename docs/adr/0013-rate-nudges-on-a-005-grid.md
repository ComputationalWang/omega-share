# ADR 0013 — Fine rate nudges on YouTube's 0.05 grid

**Status:** accepted (2026-09-30) · [OME-109](/OME/issues/OME-109) · refines the nudge row of ADR 0011

**Context:** The research (§1.3) sized a fine nudge as `1 ± min(0.1, |drift| / 5 s)`, so any value from 1.02 to 1.1 was possible. The real-YouTube sign-off (OME-91, item 5) found that the room always dropped from `fine` to 0.75/1.25 bursts. We probed a nocookie embed in Chrome for Testing 153, comparing `getCurrentTime()` with the iframe's `video.playbackRate` and `video.currentTime` every 100 ms. YouTube **floors** the requested rate to a multiple of 0.05: 1.02 and 1.03 play at 1×, 0.98 and 0.97 at 0.95, and 1.05 at 1.05. `getPlaybackRate()` echoes the unfloored value, and `getAvailablePlaybackRates()` lists only the 0.25 steps. `getCurrentTime()` tracks the video within about 5 ms. So the 2 s effective-rate check was correct: sub-step nudges really weren't applied.

**Decision:** A fine nudge is a whole number of 0.05 steps, capped at `MAX_NUDGE`: `1 ± min(2, ⌈|drift| / 250 ms⌉) · 0.05`. So drift from 100 to 250 ms gets ±0.05, and anything above that up to 1 s gets ±0.1. The effective-rate check and the fallback ladder (fine → burst → seek-only) are unchanged. They still catch a player that ignores fine rates.

**Why not a longer or delayed check window?** We tried it first (a 1 s settle plus two strikes). It still fell to burst on real YouTube, because the rate really wasn't applied. The measured timeline showed no meaningful lag after the set.

**Consequences:** The smallest nudge is now 5 % rather than 2 %. That's still well below the 25 % bursts, and the browser preserves pitch. Small drifts close faster, which also means more frequent 1× ↔ 1.05× switches. If a future provider accepts arbitrary rates, the step can become a per-adapter property.
