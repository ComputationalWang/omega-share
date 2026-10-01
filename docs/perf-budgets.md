# Performance budgets (merge-blocking)

QA measures these on every merge (Playwright + Chromium). A regression past a budget blocks the merge, and the fix gets top priority.

| Area | Metric | Budget |
|---|---|---|
| Site | Initial JS (gzipped) | ≤ 200 KB |
| Site | Time to interactive, localhost | < 1.5 s |
| Site | Frame rate, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms, in whole vsync intervals — ADR 0009) |
| Site | Main-thread work per frame, 8 avatars + video playing | ≤ 8 ms p95, per provider (YouTube, Twitch VOD, Twitch live, Vimeo, a loaded generic embed — ADR 0024), Playwright tracing off — ADR 0017 |
| Site | Missed vsyncs, 8 avatars + video playing | ≤ 1.0 % of frames, per provider, Playwright tracing off — ADR 0017 |
| Site | JS heap after 10 min in room | ≤ 150 MB |
| Sync | Spread between clients after play/pause/seek | ≤ 500 ms |
| Server | Relay latency for a control action, localhost | ≤ 50 ms |
| Server | Relay latency for a control action under flood, localhost | ≤ 50 ms p95, 24 members at the allowed chat/control rates + 1 socket flooding at 10× L1, which is throttled or closed with 4029 (ADR 0016/0018) |
| Extension | Popup opened → embeds listed | ≤ 300 ms |
| Extension | Content scripts on page load | none (inject on popup open only) |
| Extension | Persistent background | none (event-driven service worker only) |
| Load test | People in a room without breaking the budgets above | 25 |
