# M3 frame headroom: where the frame time goes (OME-185)

**Question.** In M2, frame p95 with 8 avatars and video was raw 16.70–16.80 ms on every provider and passed only after vsync quantisation (ADR 0009). Twitch live missed up to 2.8 % of vsyncs. How much of each frame is our JS, how much is layout/paint of the provider iframe, how much is GC, and what drops the frames?

**Short answer.** Our main-thread work is **0.36–0.50 ms p95 per frame** (max about 2 ms) on every provider, so there is more than 15 ms of headroom at 60 Hz. GC is 0 ms per frame. The provider iframe renderers are about 0 % busy. **The missed vsyncs are caused by the perf harness, not the app.** Playwright's `trace: "retain-on-failure"` screencasts every browser context. With 8 contexts, that puts bursts of software `DrawAndSwap` (about 10 ms each, back to back) on the one shared viz compositor thread, and every page misses the same BeginFrames at the same moment. With `--trace off`, missed vsyncs are **0 %** on every provider, Twitch live included. We also found one per-frame cost of our own, Pixi's system ticker, and fixed it.

## Method

- Scenario: exactly as `perf/site.perf.ts` / `perf/provider-sync.perf.ts`. Share the video into the lobby, join 8 browser contexts, wait until the fake player plays, then sample the first client (the observer) for 5 s. Production build (`vite preview`), headless Chromium from Playwright, 16-core Linux host, fake SDKs (OME-121). All runs used the perf flock.
- Trace: `browser.startTracing()` for the whole browser during the 5 s window. Categories: `toplevel`, `devtools.timeline`, `disabled-by-default-devtools.timeline(.frame)`, `blink.user_timing`, `v8.gc`, `cc`, `viz`, `gpu`, `benchmark`. The observer's renderer is found by a `performance.mark()` it sets at the start of the window.
- Per-frame work: frames are cut at the observer's `BeginMainThreadFrame` events. A frame's work is the sum of the top-level `ThreadControllerImpl::RunTask` durations on its `CrRendererMain` that start inside that frame, i.e. everything the main thread did for that frame: JS, style, layout, paint, commit and GC. The breakdown uses the outermost `FunctionCall`/`TimerFire`/`FireAnimationFrame` (JS), `UpdateLayoutTree`/`Layout` (style/layout), paint lifecycle + `Commit` (paint), and `MinorGC`/`MajorGC`/`V8.GC*`/`BlinkGC.*` (GC).
- Missed vsyncs: the existing rAF-delta sampler (`perf/frames.ts`), quantised as in ADR 0009, cross-checked against the trace's `DroppedFrame` events on the observer.
- Tracing adds overhead, so the traced numbers are an upper bound. The real specs rerun without Chromium tracing (last table) agree with them.

## Findings

### 1. Baseline: `main` @ `2e489de`, harness as in `playwright.config.ts` (Playwright tracing on)

| Provider | raw p95 | quantised p95 | missed vsyncs | work p95 / p99 / max | JS · style+layout · paint · GC (mean ms/frame) | viz compositor busy |
|---|---|---|---|---|---|---|
| YouTube | 16.80 | 16.67 | 1.71 % | 0.41 / 1.61 / 2.01 | 0.119 · 0.014 · 0.100 · 0 | 10.5 % |
| Twitch VOD | 16.80 | 16.67 | 3.45 % | 0.42 / 1.77 / 2.13 | 0.125 · 0.015 · 0.103 · 0 | 10.3 % |
| Twitch live | 16.80 | 16.67 | 4.55 % | 0.55 / 0.92 / 0.95 | 0.123 · 0.069 · 0.112 · 0 | 13.4 % |
| Vimeo | 16.80 | 16.67 | 1.71 % | 0.47 / 1.73 / 2.14 | 0.123 · 0.016 · 0.104 · 0 | 10.3 % |

The provider iframes' own renderer main threads were 0.1 % busy. The fake SDKs do almost nothing, and they are out-of-process iframes, so their work never lands on our main thread anyway.

### 2. What drops the frames

- The gaps are periodic, and all 8 pages drop the **same** frames. On Twitch live the stalls come about every 700 ms (+241, +941, +1641 … ms), otherwise about every 1 s. Each stall is 26–58 ms. `DroppedFrame` counts are identical across the 8 renderers (for example, 14 each on Twitch live).
- In every stall the observer's main thread is idle. The busy thread is the GPU process's **`VizCompositorThread`**: back-to-back `Display::DrawAndSwap` → `SoftwareRenderer` tasks of about 10.8 ms each, next to `devtools/protocol/page_handler.cc ScreencastFrameCaptured` tasks on the browser's thread pool (80 in 5 s, 112 on Twitch live). That is Playwright's trace screencast. It captures frames for every context, and headless Chromium composites those in software, on one thread shared by all pages.
- Twitch live is the worst case because it has more screencast frames (112 against 80). The LIVE pill's on-air lamp blinks, so there is always damage to capture (see 4).
- **Probe (one variable):** the same run with `--trace off` gave **0 missed vsyncs and 0 `DroppedFrame` events on every provider**. Viz busy fell from 10–13 % to 3 %, and our work per frame did not change.

### 3. Our per-frame cost: Pixi's system ticker (fixed)

The room renders on demand (`room-view.ts`, `autoStart: false`, `app.ticker.stop()`). But Pixi 8's `SchedulerSystem` (texture GC timers) and `EventsTicker` subscribe to **`Ticker.system`**, and that ticker auto-starts its own rAF loop. The trace showed `CanvasPool-*.js _tick` 301 times in 301 frames, 17–20 ms per 5 s, and a `BeginMainFrame` forced every frame even in a still room.

Fix: `quietSystemTicker(Ticker.system)` sets `autoStart = false`, stops the ticker, and returns a pump that `room-view` calls just before each `app.render()`, so Pixi's GC timers still advance on real renders. Pixi's event system is unused, because clicks go to the DOM seat overlay. Test: `apps/web/test/room-view.test.ts`, against Pixi's real `Ticker`.

### 4. Remaining cost: the on-air lamp (assets, handed off)

`.ui-onair` (`assets/src/live.ts`) blinks through a `background-position` keyframe animation with `steps(1) infinite`. Chromium can't run `background-position` on the compositor, so while a live stream shows, the main thread recalculates style every frame: 301 `UpdateLayoutTree` per 301 frames, elementCount 1, about 0.065 ms per frame. Each change also damages the frame. The cost is small, but it is the only thing still waking the main thread every frame in a live room. An opacity step animation on a second glyph layer runs on the compositor. That is a design-asset change (`assets/**`) and was handed to the Creative Designer as a non-blocking follow-up.

### 5. After the fix: `lead-engineer/OME-185-frame-headroom`, traced, `--trace off`

| Provider | raw p95 | quantised p95 | missed vsyncs | work p95 / p99 / max | JS · style+layout · paint · GC (mean ms/frame) | viz busy |
|---|---|---|---|---|---|---|
| YouTube | 16.70 | 16.67 | 0 % | 0.46 / 1.61 / 1.82 | 0.074 · 0.014 · 0.098 · 0 | 1.1 % |
| Twitch VOD | 16.70 | 16.67 | 0 % | 0.40 / 1.42 / 1.66 | 0.085 · 0.013 · 0.096 · 0 | 1.0 % |
| Twitch live | 16.80 | 16.67 | 0 % | 0.50 / 0.74 / 0.79 | 0.069 · 0.065 · 0.117 · 0 | 2.7 % |
| Vimeo | 16.80 | 16.67 | 0 % | 0.36 / 1.49 / 1.83 | 0.065 · 0.013 · 0.087 · 0 | 0.9 % |

Pixi `_tick`: 0 calls, down from 301. What JS is left per frame is mostly the harness's own rAF sampler.

The unchanged specs from `perf/site.perf.ts` / `perf/provider-sync.perf.ts`, on the fix branch without Chromium tracing:

| Harness | YouTube | Twitch VOD | Twitch live | Vimeo | load test (25) |
|---|---|---|---|---|---|
| as today (Playwright tracing on), `bun run perf` | 1.7 % | 1.0 % | 2.0 % | 0.7 % | 0.0 % |
| `--trace off` | 0 % (301 frames) | 0 % (301) | 0 % (300) | 0 % (300) | 0 % (480) |

The raw p95 is 16.70–16.80 ms in every row, and it always will be. A rAF delta can't go below one vsync interval, so raw p95 measures the display's refresh interval, not headroom (ADR 0009). That is why the headroom metric below measures work instead.

## Headroom metric for `perf/**` (method for QA, ADR 0017)

1. **Run the frame specs without Playwright tracing.** In `playwright.config.ts`, set `use: { trace: "off" }` on the `perf` project (or `test.use({ trace: "off" })` in the frame specs). Trace screencasts are the missed-vsync source, and a perf run shouldn't measure its own recorder.
2. **`site.frameWorkP95.<provider>` ≤ 8 ms**: the p95 of main-thread work per frame on the observer.
   - Wrap the 5 s `frameTimes()` window in `browser.startTracing(undefined, { categories: ["toplevel", "disabled-by-default-devtools.timeline.frame", "blink.user_timing"] })` / `stopTracing()`. Mark the observer with `performance.mark("omega:observer")`.
   - Parse the returned buffer. Take the observer's `pid`/`tid` from the mark event. Cut frames at that thread's `BeginMainThreadFrame` events (instant events, no `dur`). A frame's work is the sum of `dur` of `ThreadControllerImpl::RunTask` (`toplevel`) on that thread starting in `[frame_i, frame_i+1)`. Divide by 1000 to get ms, then take the p95 over frames.
   - Valibot-parse the trace events at the boundary: `{ name: string, ph: string, pid: number, tid: number, ts: number, dur?: number }`.
   - Expect about 0.4–0.5 ms today.
3. **`site.missedVsync.<provider>` ≤ 1.0 %**: `summarizeFrames(...).missedPct`, already computed. Report it as its own row instead of only in the note. Expect 0 %.
4. Keep `site.frameP95` (quantised) as it is. The ADR 0009 budget stays; the two new rows add the headroom it can't show.

Why not `long-animation-frame` or JS-side timing: LoAF only reports frames over 50 ms, and a rAF callback can't see style, layout, paint, commit or other tasks. The trace is the only in-harness source of per-frame main-thread work in Chromium.

## Reproduce

The diagnosis spec and analyser were throwaway (run-scratch). Their logic is the method above. To repeat: put a copy of the frame spec with the tracing wrapper under `perf/`, then run `OMEGA_WEB_MODE=preview flock "$XDG_RUNTIME_DIR/omega-share-perf.lock" bunx playwright test --project=perf [--trace off] <spec>`.
