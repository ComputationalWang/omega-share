# ADR 0017 — Frame headroom: main-thread work per frame and missed vsyncs, measured without Playwright tracing

**Status:** accepted (2026-09-30) · [OME-185](/OME/issues/OME-185) · extends ADR 0009 · research: `docs/research/m3-frame-headroom.md`

**Decision:**
1. Frame perf specs run with Playwright tracing **off** (`trace: "off"` on the `perf` project).
2. Two budgets are added next to `site.frameP95`, per provider: `site.frameWorkP95.<provider>` ≤ **8 ms** (the p95 of the observer's main-thread work per frame, from a Chromium trace: `ThreadControllerImpl::RunTask` time between consecutive `BeginMainThreadFrame`s), and `site.missedVsync.<provider>` ≤ **1.0 %** (quantised rAF deltas of two or more intervals).
3. `site.frameP95` stays as ADR 0009 defines it.

**Why:** a raw rAF-delta p95 can never go below one vsync interval, so on a 60 Hz clock it reads about 16.7 ms whether a frame costs 0.4 ms or 16 ms. It shows no headroom (ADR 0009). The trace shows our work is about 0.4–0.5 ms p95. The 1–4.6 % of missed vsyncs seen in M2 came from Playwright's trace screencast of all 8 contexts, which is software-composited on the shared viz thread. With tracing off they drop to 0 % on every provider. A perf run must not measure its own recorder.

**Consequences:** a failing perf spec no longer leaves a Playwright trace. Rerun it with `--trace on` to debug, and know that the missed-vsync count is not valid in that run. The work metric needs Chromium tracing around the 5 s window. Keep its categories minimal (`toplevel`, `disabled-by-default-devtools.timeline.frame`, `blink.user_timing`). It is Chromium-only, like the rest of the perf project. If ADR 0009's `VSYNC_MS` changes, both new rows follow it.
