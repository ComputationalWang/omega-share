# OME-1514 deploy of 1844e88 (hide chat in full screen, floor sit, frame/garland colours)
- Gate on 1844e88: `bun run check` exit 0 (black-box 636 pass, 5 fail not in the manifest, as before); `bun run e2e` 583 passed; flocked `bun run perf`: 136 pass, 1 FAIL, 1 pending (soak). The one FAIL: "Missed vsyncs with the chat popped out, 8 avatars + generic embed" 1.0 % (3 of 298 frames, budget <= 1.0 %); two isolated reruns of perf/popout.perf.ts: 0 of 301 frames both times, 21 pass.
- No DB migration: nothing under apps/server-rs/src/store changed since the live cf69c70.
- Deployed with deploy/deploy.sh (Rust); live build-version "1844e88".
- Hosted smoke (public lobby, two clients, headed xvfb): hosted-smoke.json + PNGs. The "no page errors" row fails on a Chromium `getLayoutMap()` SecurityError in full screen (not from repo code: no getLayoutMap in apps/web/src); the five feature rows pass.
