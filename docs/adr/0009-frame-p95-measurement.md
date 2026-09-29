# ADR 0009 — Frame p95 is measured in whole vsync intervals

**Status:** accepted (2026-09-29) · [OME-26](/OME/issues/OME-26) / [OME-33](/OME/issues/OME-33) · `perf/metrics.ts` `vsyncFrames`

**Decision:** `site.frameP95` is the p95 of rAF deltas rounded to a whole number of 60 Hz vsync intervals (at least one), via `vsyncFrames`. The perf report keeps the raw rAF-delta p95 and the missed-vsync count in the metric note. The budget is still 16.7 ms.

**Why:** in headless Chromium, raw rAF deltas never drop below one interval and carry about ±0.1 ms of timer jitter. On a blank page the raw p95 is already about 16.7 ms (max 16.8 ms), so a raw-delta metric would pass or fail the budget on noise alone. After snapping, a presented frame counts as 16.67 ms and a missed vsync as 33.3 ms or more. So the budget now means what `docs/perf-budgets.md` says: 60 fps, with no more than 5% of frames missing vsync.

**Consequences:** do not switch back to raw deltas without changing the budget too. A regression now shows up as missed vsyncs, not as sub-millisecond drift. For drift, check the raw p95 in the note. If perf ever runs on a display that isn't 60 Hz, `VSYNC_MS` in `perf/site.perf.ts` has to match it.
