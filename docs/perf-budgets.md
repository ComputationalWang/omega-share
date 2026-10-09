# Performance budgets (merge-blocking)

QA measures these on every merge (Playwright + Chromium; the Firefox rows in headless Firefox through Puppeteer/BiDi). A regression past a budget blocks the merge, and the fix gets top priority.

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
