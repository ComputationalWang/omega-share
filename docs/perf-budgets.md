# Performance budgets (merge-blocking)

QA measures these on every merge (Playwright + Chromium; the Firefox rows in headless Firefox through Puppeteer/BiDi). A regression past a budget blocks the merge, and the fix gets top priority.

| Area | Metric | Budget |
|---|---|---|
| Site | Initial JS (gzipped) | ≤ 200 KB |
| Site | Time to interactive, localhost | < 1.5 s |
| Site | Frame rate, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals — ADR 0009) |
| Site | Main-thread work per frame, 8 avatars + video playing | ≤ 8 ms p95, per provider (YouTube, Twitch VOD, Twitch live, Vimeo, a loaded generic embed — ADR 0024), Playwright tracing off — ADR 0017 |
| Site | Missed vsyncs, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, Playwright tracing off — ADR 0017 |
| Site | Frame rate with a chat burst, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals), per provider, the chat log on screen while 7 members chat at the room's rate limit (a burst of 5 each, then 1/s: `ws.ts` CHAT_BURST / CHAT_PER_SECOND); the median of 3 bursts, and only the observer loads a generic embed (OME-813) — OME-594 |
| Site | Main-thread work per frame with a chat burst, 8 avatars + video playing | ≤ 8 ms p95, per provider, same chat burst (median of 3 bursts) — OME-594 |
| Site | Missed vsyncs with a chat burst, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, same chat burst (median of 3 bursts) — OME-594 |
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

## Landing

The home page at `/`, measured on the production preview build (`vite preview`, the same build `bun run perf` serves) from a cold cache, before any user interaction: no pointer movement, no focus, no key press. Throttling profile: the one every other perf spec uses, Playwright's `Desktop Chrome` device (1280×720, DPR 1) on localhost with **no CPU and no network throttling**. The landing spec runs three cold loads, each in a fresh browser context, after a warm-up load; transfer is the largest of the three, the timings are their median. Spec: `perf/landing.perf.ts` (OME-763). Targeted post-merge check (ADR 0036) for any change to `apps/web/index.html`, `apps/web/src/main.ts`, `apps/web/src/home.ts`, `apps/web/src/style.css`, `apps/web/public/**` or the web build config: `bun run perf perf/landing.perf.ts`.

| Area | Metric | Budget |
|---|---|---|
| Landing | Total transfer at `/` before interaction (gzipped) | ≤ 120 KB: every document, script, stylesheet, image, font and other static response the page fetches before interaction (the home chunk loaded on `load` included), each body gzipped at zlib level 6. API calls (fetch/XHR) are listed in the note but not counted. The lazily warmed room/Pixi chunks are excluded only while they are not fetched before interaction: anything fetched before interaction counts |
| Landing | Largest Contentful Paint at `/` | ≤ 1.5 s, same throttling profile as the other perf specs (none) |
| Landing | Cumulative Layout Shift at `/` | ≤ 0.05: every layout shift without recent input from navigation until load + 1 s, summed (no session windowing, so it is never lower than the web-vitals value) |
| Landing | Longest task before the nickname field is usable | ≤ 50 ms (no long task): `PerformanceObserver("longtask")` entries that start before the field is usable, meaning the later of DOMContentLoaded end and the site's `omega:interactive` mark (set once `main.ts` has wired the form) |
