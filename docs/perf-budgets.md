# Performance budgets (merge-blocking)

QA measures these on every merge (Playwright + Chromium). A regression past a budget blocks the merge, and the fix gets top priority.

| Area | Metric | Budget |
|---|---|---|
| Site | Initial JS (gzipped) | ≤ 200 KB |
| Site | Time to interactive, localhost | < 1.5 s |
| Site | Frame rate, 8 avatars + video playing | 60 fps (p95 frame ≤ 16.7 ms) |
| Site | JS heap after 10 min in room | ≤ 150 MB |
| Sync | Spread between clients after play/pause/seek | ≤ 500 ms |
| Server | Relay latency for a control action, localhost | ≤ 50 ms |
| Extension | Popup opened → embeds listed | ≤ 300 ms |
| Extension | Content scripts on page load | none (inject on popup open only) |
| Extension | Persistent background | none (event-driven service worker only) |
| Load test | People in a room without breaking the budgets above | 25 |
