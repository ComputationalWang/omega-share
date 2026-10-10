# Performance budgets (merge-blocking)

QA measures these on every merge that touches a perf-relevant path, daily and at sign-off (Playwright + Chromium; the Firefox rows in headless Firefox through Puppeteer/BiDi). A regression past a budget blocks the merge, and the fix gets top priority. When and how often perf runs, and how a verdict is reached: "Sampling and verdicts" below.

| Area | Metric | Budget |
|---|---|---|
| Site | Initial JS (gzipped) | ≤ 200 KB |
| Site | Time to interactive, localhost | < 1.5 s |
| Site | Frame rate, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals — ADR 0009) |
| Site | Main-thread work per frame, 8 avatars + video playing | ≤ 8 ms p95, per provider (YouTube, Twitch VOD, Twitch live, Vimeo, a loaded generic embed — ADR 0024), Playwright tracing off — ADR 0017 |
| Site | Missed vsyncs, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, Playwright tracing off — ADR 0017 |
| Site | Frame rate with a chat burst, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per provider, the chat log on screen while 7 members chat at the room's rate limit (a burst of 5 each, then 1/s: `ws.ts` CHAT_BURST / CHAT_PER_SECOND) — OME-594 |
| Site | Main-thread work per frame with a chat burst, 8 avatars + video playing | ≤ 8 ms p95, per provider, same chat burst — OME-594 |
| Site | Missed vsyncs with a chat burst, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, same chat burst — OME-594 |
| Site | Frame rate in the 1920×1080 wide layout with a chat burst, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per provider, desktop Chromium at 1920×1080 in the wide layout (the chat a full-height column beside the room, OME-642) while 7 members chat at the room's rate limit (a burst of 5 each, then 1/s) — OME-602 (1920×1080 wide layout) |
| Site | Main-thread work per frame in the 1920×1080 wide layout with a chat burst, 8 avatars + video playing | ≤ 8 ms p95, per provider, same wide-layout chat burst — OME-602 (1920×1080 wide layout) |
| Site | Missed vsyncs in the 1920×1080 wide layout with a chat burst, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, same wide-layout chat burst — OME-602 (1920×1080 wide layout) |
| Site | Frame rate on a phone, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per provider, Playwright mobile emulation of a Pixel-class phone (`devices["Pixel 7"]`: 412×915, DPR 2.625, touch) in the phone watch layout, the room window and the chat log on screen while the room is dragged sideways and 7 members chat at 1/s — OME-596 |
| Site | Main-thread work per frame on a phone, 8 avatars + video playing | ≤ 8 ms p95, per provider, same phone run — OME-596 |
| Site | Missed vsyncs on a phone, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, same phone run — OME-596 |
| Site | Frame rate in full screen, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per provider, desktop Chromium with our wrapper in full screen and the chat strip open (the room hidden, its render loop paused) while 7 members chat at 1/s — OME-597 |
| Site | Main-thread work per frame in full screen, 8 avatars + video playing | ≤ 8 ms p95, per provider, same full-screen run — OME-597 |
| Site | Missed vsyncs in full screen, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, same full-screen run — OME-597 |
| Site | Longest task entering or leaving full screen | ≤ 50 ms (no long task), per provider, `PerformanceObserver("longtask")` for 1 s after each press of the full-screen key — OME-597 |
| Site | Frame rate with the chat popped out, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per provider, the room tab (desktop Chromium) with the chat in its pop-out window (`chat.html`, no second Pixi renderer, no second socket) while 7 members chat at 1/s, relayed over the BroadcastChannel — OME-598 |
| Site | Main-thread work per frame with the chat popped out, 8 avatars + video playing | ≤ 8 ms p95, per provider, same pop-out run — OME-598 |
| Site | Missed vsyncs with the chat popped out, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, same pop-out run — OME-598 |
| Site | Frame rate with the room popped out, 25 members + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), each window on its own: the room tab (the picture only, its Pixi renderer paused) and the room window (`room.html`, the one renderer: 25 avatars, 8 seated, someone always walking, and the chat) while 24 members chat at ~8/s room-wide and a seat changes every 100 ms, relayed over the BroadcastChannel — OME-600 |
| Site | Main-thread work per frame with the room popped out, 25 members + video playing | ≤ 8 ms p95, each window, same pop-out room run — OME-600 |
| Site | Missed vsyncs with the room popped out, 25 members + video playing | ≤ 1.0 % of frames, each window, same pop-out room run — OME-600 |
| Site | Frame rate with 25 members walking | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per forced walk tier (Basic, Smooth: `localStorage["omega.motion"]`, ADR 0037), desktop Chromium and `devices["Pixel 7"]`: the observer plus 24 bots sitting down on free seats and standing up again (one change every ~120 ms, at least 15 of the 24 walking inside the window), video playing — OME-731 |
| Site | Main-thread work per frame with 25 members walking | ≤ 8 ms p95, per forced walk tier (Basic, Smooth: `localStorage["omega.motion"]`, ADR 0037), desktop Chromium and `devices["Pixel 7"]`, same run — OME-731 |
| Site | Missed vsyncs with 25 members walking | ≤ 1.0 % of frames, per forced walk tier (Basic, Smooth: `localStorage["omega.motion"]`, ADR 0037), desktop Chromium and `devices["Pixel 7"]`, same run — OME-731 |
| Site | JS heap after 10 min in room | ≤ 150 MB |
| Sync | Spread between clients after play/pause/seek | ≤ 500 ms |
| Sync | Spread between clients after a queue advance | ≤ 1.5 s, first to last of 8 clients playing the next item after a video ends — ADR 0031 §7 |
| Server | Relay latency for a control action, localhost | ≤ 50 ms |
| Server | Relay latency for a control action under flood, localhost | ≤ 50 ms p95, 24 members at the allowed chat/emote/control rates + 1 socket flooding at 10× L1, which is throttled or closed with 4029 (ADR 0016/0018) |
| Extension | Popup opened → embeds listed | ≤ 300 ms |
| Extension | Content scripts on page load | none (inject on popup open only) |
| Extension | Persistent background | none (event-driven service worker only) |
| Extension | Popup opened → embeds listed, Firefox | ≤ 300 ms p95, headless Firefox through Puppeteer/BiDi (`bun run ext:firefox`, OME-593) |
| Extension | Content scripts on page load, Firefox | none (inject on popup open only) |
| Extension | Persistent background, Firefox | none (non-persistent event page: Firefox MV3 has no service worker — ADR 0005) |
| Load test | People in a room without breaking the budgets above | 25 |

## Sampling and verdicts

ADR 0036, amendment of 2026-10-10 ([OME-818](/OME/issues/OME-818)).

- **When perf runs.** Perf runs per merge only when the merge touches a perf-relevant path (ADR 0036 lists them), and then only the specs that cover the touched paths. It also runs in full for wide-blast-radius merges, in the daily full run and at every milestone sign-off. Every run is flocked: `flock "$XDG_RUNTIME_DIR/omega-share-perf.lock" bun run perf [perf/<spec>.perf.ts …]`.
- **One pass is the verdict.** A row's number comes from the samples one pass takes. The row's note prints the sample count. Frame-time, work-per-frame and missed-vsync rows of `site.perf.ts`, `provider-sync.perf.ts` and `chat.perf.ts` take 3 back-to-back 5 s rAF windows on the set-up room ([OME-846](/OME/issues/OME-846); in the chat spec each window is a full bucket refill plus a burst): missed vsyncs pooled over all of them (about 900 frames, so one stray frame is 0.11 %, not 0.34 %), frame p95 and work p95 the median of the 3 window p95s. The other frame rows still take p95 (or the missed share) over one rAF window of at least 5 s, about 300 frames at 60 Hz (8 s for the popped-out room and the 25-client load test), until one of them flips (next bullet but one; the helpers are `sampledFrames` in `perf/frames.ts` and `summarizeWindows` in `perf/spread.ts`). Sync spreads (`sync.spread`, `sync.spread.<provider>`) take 4 rounds across 8 clients, 12 samples (8 for Twitch live: pause and play-from-live): per action the upper median of its 4 rounds (the second worst), and the row is the worst action, so one slow round of a bimodal spread doesn't decide it but two do; the note prints each action's max too. Queue advances take the worst of 3. Landing takes the median of 3 cold loads after a warm-up. The Firefox popup row takes p95 of 30 opens, relay latency p95 of 50 control actions, and the load-test relay row one probe per 100 ms over 8 s. No ×3 reruns of the whole set.
- **A failing row gets one confirm rerun, of its spec only.** Run `bun run perf --no-build perf/<that spec>.perf.ts` (flocked). The build already matches HEAD, and `bun run perf` skips a matching build on its own anyway. If the confirm passes, the row passes, and the report gives both numbers and marks the first as noise. If it fails, the row is red and blocks as before. One confirm only: a third run never overturns two fails.
- **Unstable rows take more samples, not more reruns.** If a row's verdict flips between single passes on an unchanged `main`, its spec takes more samples per run (more windows or rounds, with a median or p95 over them) until 3 single passes agree. The daily full run is where flips show.
- **Build once per sha.** `bun run perf` stamps each build output dir with HEAD's sha (plus the server URL the web build bakes in). It rebuilds only when a stamp is missing or doesn't match, or when the build inputs (`apps/`, `packages/`, `assets/`, `package.json`, `bun.lock`, `tsconfig.base.json`) have uncommitted changes. `--rebuild` forces a build, and is needed after changing a git-ignored env file Vite reads (`.env.local`). `--no-build` skips it (`perf/build-stamp.ts`).

## Landing

The home page at `/`, measured on the production preview build (`vite preview`, the same build `bun run perf` serves) from a cold cache, before any user interaction: no pointer movement, no focus, no key press. Throttling profile: the one every other perf spec uses, Playwright's `Desktop Chrome` device (1280×720, DPR 1) on localhost with **no CPU and no network throttling**. The landing spec runs three cold loads, each in a fresh browser context, after a warm-up load; transfer is the largest of the three, the timings are their median. Spec: `perf/landing.perf.ts` (OME-763). Targeted post-merge check (ADR 0036) for any change to `apps/web/index.html`, `apps/web/src/main.ts`, `apps/web/src/home.ts`, `apps/web/src/style.css`, `apps/web/public/**` or the web build config: `bun run perf perf/landing.perf.ts`.

| Area | Metric | Budget |
|---|---|---|
| Landing | Total transfer at `/` before interaction (gzipped) | ≤ 120 KB: every document, script, stylesheet, image, font and other static response the page fetches before interaction (the home chunk loaded on `load` included), each body gzipped at zlib level 6. API calls (fetch/XHR) are listed in the note but not counted. The lazily warmed room/Pixi chunks are excluded only while they are not fetched before interaction: anything fetched before interaction counts |
| Landing | Largest Contentful Paint at `/` | ≤ 1.5 s, same throttling profile as the other perf specs (none) |
| Landing | Cumulative Layout Shift at `/` | ≤ 0.05: every layout shift without recent input from navigation until load + 1 s, summed (no session windowing, so it is never lower than the web-vitals value) |
| Landing | Longest task before the nickname field is usable | ≤ 50 ms (no long task): `PerformanceObserver("longtask")` entries that start before the field is usable, meaning the later of DOMContentLoaded end and the site's `omega:interactive` mark (set once `main.ts` has wired the form) |
