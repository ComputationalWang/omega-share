# Perf budget report

| Status | Area | Metric | Measured | Budget | Notes |
|---|---|---|---|---|---|
| ✅ PASS | Site | Initial JS (gzipped) | 10.6 KB | ≤ 200.0 KB | 1 initial JS files |
| ✅ PASS | Site | Time to interactive, localhost | 21.0 ms | < 1500.0 ms |  |
| ✅ PASS | Site | p95 frame time, 8 avatars + video | 16.7 ms | ≤ 16.7 ms | 301 frames, 0 missed vsync (0.0%), raw p95 16.80 ms; ⚠ raw p95 16.80 ms > 16.7 ms; video playing (fake player) |
| ✅ PASS | Site | p95 frame time, 8 avatars + Vimeo video | 16.7 ms | ≤ 16.7 ms | 300 frames, 0 missed vsync (0.0%), raw p95 16.70 ms; ⚠ raw p95 16.70 ms > 16.7 ms; Vimeo playing (fake SDK) |
| ✅ PASS | Site | p95 frame time, 8 avatars + Twitch VOD | 16.7 ms | ≤ 16.7 ms | 301 frames, 0 missed vsync (0.0%), raw p95 16.80 ms; ⚠ raw p95 16.80 ms > 16.7 ms; Twitch VOD playing (fake SDK) |
| ✅ PASS | Site | p95 frame time, 8 avatars + Twitch live | 16.7 ms | ≤ 16.7 ms | 301 frames, 0 missed vsync (0.0%), raw p95 16.70 ms; ⚠ raw p95 16.70 ms > 16.7 ms; Twitch live playing (fake SDK) |
| ✅ PASS | Site | p95 frame time, 8 avatars + generic embed | 16.7 ms | ≤ 16.7 ms | 301 frames, 0 missed vsync (0.0%), raw p95 16.70 ms; ⚠ raw p95 16.70 ms > 16.7 ms; generic embed loaded (local page repainting every frame) |
| ✅ PASS | Site | Main-thread work p95 per frame, 8 avatars + YouTube | 1.7 ms | ≤ 8.0 ms | 301 traced frames, max 3.46 ms; video playing (fake player) |
| ✅ PASS | Site | Missed vsyncs, 8 avatars + YouTube | 0.0 % | ≤ 1.0 % | 0 of 301 frames; Playwright tracing off; video playing (fake player) |
| ✅ PASS | Site | Main-thread work p95 per frame, 8 avatars + Twitch VOD | 1.6 ms | ≤ 8.0 ms | 301 traced frames, max 3.03 ms; Twitch VOD playing (fake SDK) |
| ✅ PASS | Site | Missed vsyncs, 8 avatars + Twitch VOD | 0.0 % | ≤ 1.0 % | 0 of 301 frames; Playwright tracing off; Twitch VOD playing (fake SDK) |
| ✅ PASS | Site | Main-thread work p95 per frame, 8 avatars + Twitch live | 2.0 ms | ≤ 8.0 ms | 301 traced frames, max 3.36 ms; Twitch live playing (fake SDK) |
| ✅ PASS | Site | Missed vsyncs, 8 avatars + Twitch live | 0.0 % | ≤ 1.0 % | 0 of 301 frames; Playwright tracing off; Twitch live playing (fake SDK) |
| ✅ PASS | Site | Main-thread work p95 per frame, 8 avatars + Vimeo | 1.9 ms | ≤ 8.0 ms | 300 traced frames, max 3.01 ms; Vimeo playing (fake SDK) |
| ✅ PASS | Site | Missed vsyncs, 8 avatars + Vimeo | 0.0 % | ≤ 1.0 % | 0 of 300 frames; Playwright tracing off; Vimeo playing (fake SDK) |
| ✅ PASS | Site | Main-thread work p95 per frame, 8 avatars + generic embed | 2.5 ms | ≤ 8.0 ms | 301 traced frames, max 3.99 ms; generic embed loaded (local page repainting every frame) |
| ✅ PASS | Site | Missed vsyncs, 8 avatars + generic embed | 0.0 % | ≤ 1.0 % | 0 of 301 frames; Playwright tracing off; generic embed loaded (local page repainting every frame) |
| ⏳ PENDING | Site | JS heap after 10 min soak (after GC) | — | ≤ 150.0 MB | slow (10 min): run `bun run perf --soak` |
| ✅ PASS | Sync | Spread after play/pause/seek | 0.6 ms | ≤ 500.0 ms | pause 0 / play 1 / seek 1 ms, worst of 2 rounds, 8 clients, fake player |
| ✅ PASS | Sync | Spread after play/pause/seek, Twitch VOD | 15.3 ms | ≤ 500.0 ms | pause 0 / play 15 / seek 3 ms, worst of 2 rounds, 8 clients, fake SDK, no rate → seek-only |
| ✅ PASS | Sync | Spread after pause/play-from-live, Twitch live | 15.2 ms | ≤ 500.0 ms | pause 15 (last client +44) / play 15 (last client +46) ms, first-to-last client, worst of 2 rounds, 8 clients, fake SDK |
| ✅ PASS | Sync | Spread after play/pause/seek, Vimeo (seek-only) | 16.3 ms | ≤ 500.0 ms | pause 0 / play 16 / seek 1 ms, worst of 2 rounds, 8 clients, fake SDK, rate rejected → seek-only |
| ✅ PASS | Sync | Queue advance spread, 8 clients, YouTube | 248.8 ms | ≤ 1500.0 ms | 205 / 249 / 91 ms, worst of 3 advances on ended, 8 clients, fake YouTube, http://localhost:8967 |
| ✅ PASS | Server | Relay latency, control action | 0.9 ms | ≤ 50.0 ms | control seek → playback at all 25 sockets, p95 of 50; sit/stand p95 0.3 ms |
| ✅ PASS | Server | Relay latency, control action, under flood | 1.0 ms | ≤ 50.0 ms | control seek → playback at 24 members, p95 of 50; members sent 288 chats, 0 rate_limited; attacker sent 1287, got 24 rate_limited, closes 4029×23 |
| ✅ PASS | Extension | Popup opened → embeds listed | 68.9 ms | ≤ 300.0 ms | p95 of 5 opens on providers-embed (4 synced + 2 generic embeds) |
| ✅ PASS | Extension | Declared content scripts | 0 | ≤ 0 |  |
| ✅ PASS | Extension | Persistent background violations | 0 | ≤ 0 |  |
| ✅ PASS | Load test | Relay latency p95, 25 in room + traffic | 2.5 ms | ≤ 50.0 ms | 81 sit/stand samples (slowest of 24 bots in one page, client queueing included); 25 members, 1752 chats + 2253 seat changes received by bots, 0 error frames (no rate_limited) with M3 limits on |
| ✅ PASS | Load test | p95 frame time, 25 in room + traffic | 16.7 ms | ≤ 16.7 ms | 481 frames, 0 missed vsync (0.0%), raw p95 16.70 ms; ⚠ raw p95 16.70 ms > 16.7 ms; 8 seated + 17 standing; video playing (fake player) |

**29 passed, 0 failed, 1 pending.**
