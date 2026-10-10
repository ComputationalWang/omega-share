# M7 sign-off: full suite, flocked perf, deploy, hosted smoke, Firefox (OME-603)

Everything ran on one SHA: **`main` @ `317f96c`**, the OME-701 a11y merge. It ran 2026-10-10 from QA2's clean, detached checkout on QA2's ports (4410/5183/8797), with headless Chromium unless noted. Real-provider checks ran headed on xvfb (board rule). Perf ran under the machine-wide perf lock. That SHA is live on the box.
Raw evidence: [`m7-signoff/`](m7-signoff/) (hosted smoke script and JSON, screenshots, perf report, real-provider JSON lines).

| Gate | Result |
|---|---|
| `bun run check` (typecheck, lint, unit) | **4694 pass, 1 skip, 0 fail** (150 files) |
| Full e2e (`CI=1 bun run e2e`: e2e, e2e-sync, e2e-tunnel) | **247 passed, 0 failed, 0 flaky** (2.7 min). Includes `m7-a11y` with the six OME-701 `test.fail`s now plain tests |
| Flocked perf incl. soak (`flock … bun run perf --soak`) | **119 passed, 0 failed, 0 pending** ([report](m7-signoff/perf-report.md)) |
| Firefox lane (`bun run ext:firefox`, X1) | **79 unit pass, 4/4 e2e, 2/2 perf**. Popup → embeds listed p95 **86–87 ms** (≤ 300), 0 content scripts, 0 persistent background |
| Deploy `317f96c` (`deploy/deploy.sh` as `deploy@`) | live: `current` → `releases/317f96c…`, service active since 02:25:24 UTC, public `/healthz` 200. No migration since the deployed `d312b6b`, so no wait for a snapshot |
| Hosted smoke, M7 (full screen, pop-out, report → takedown) | **12/12 green**, 1 room created and then taken down by the operator CLI on the box |
| Hosted real providers, headed on xvfb | Vimeo, Twitch VOD, Twitch live, the Twitch mature gate and refused embeds: **all pass** |
| Dev-only real specs, headed on xvfb | `real-youtube` (7) + `real-invite-referrer`: **8 passed, 0 failed**; 14 skipped (tunnel lanes, as in M6) |

## Perf on 317f96c (budgets in `docs/perf-budgets.md`)

- **Frame p95** is 16.7 ms on every row: 8 avatars with each of the five providers, chat burst, the 1920×1080 wide layout, and the chat popped out. Missed vsyncs are 0 everywhere except one row: wide layout + generic embed, 1 of 300 (0.3 %, budget ≤ 1 %).
- **Main thread p95:** 1.5–4.0 ms per frame (≤ 8).
- **Sync spread:** YouTube 1.0 ms, Twitch VOD 14.8 ms, Twitch live 14.3 ms, Vimeo 15.7 ms (≤ 500). Queue advance 236 ms (≤ 1500).
- **Site load:** TTI 22.7 ms on localhost, initial JS 11.5 KB gz (≤ 200 KB).
- **Heap after the 10 min soak:** 5.3 MB (4.2 → 5.3 MB, ≤ 150).
- **Relay:** control 1.0 ms, under flood 0.8 ms; 25 in a room with traffic, p95 2.2 ms (≤ 50).
- **Extension popup:** Chromium 52.3 ms, Firefox 87.0 ms (≤ 300).

## Hosted smoke (https://omega-share.duckdns.org, 317f96c)

Script: [`m7-signoff/m7-smoke.ts.txt`](m7-signoff/m7-smoke.ts.txt) (scratch, not part of `e2e/**`). Two headless browsers drive the real UI. A is the owner, B is a guest. Results: [`hosted-smoke.json`](m7-signoff/hosted-smoke.json).

| # | Check | Result |
|---|---|---|
| 1a | A creates one public room from the landing page and joins. Focus lands on the room's first key, not `<body>` (OME-701) | pass, focus on `room-popout` |
| 1b | B joins `/r/<id>`. A queues Vimeo 1084537, and both get the shared video | pass |
| 2 | Full screen from the key: `fs-root` is the full-screen element, with the strip and video inside. On exit, focus returns to the full-screen key (OME-701) | pass |
| 3 | Room pop-out: `room.html` shows the room, and the main tab shows the away placeholder. Bring back: the room, chat, video and socket are intact | pass |
| 4 | B reports the room (reason "other", plus a note) and sees "Thanks, we got it" | pass, `POST` 202 |
| 5b | No CSP violations or page errors | pass, 0/0 |
| 6a | After the operator's takedown, A and B both show the takedown screen | pass |
| 6b | Both sockets close with **4006** (`TAKEN_DOWN`) and don't reconnect | pass |
| 6c | A fresh rejoin of `/r/<id>` is refused with 4006 and the takedown screen | pass |
| 6d | `GET /rooms` no longer lists the id | pass |
| 6e | `POST /rooms/<id>/report` answers 404 `room_not_found` | pass |
| 7 | No CSP violations or page errors for the whole run | pass |

**Operator CLI on the box** ([OME-721](/OME/issues/OME-721), run by the Lead as `admin@`, because QA2 only holds the `deploy@` key):
- `reports list` showed room `4sxi63cd46peqlhzx24ewevqqy` with 1 open report, reason `other`, the note, and `playing: https://player.vimeo.com/video/1084537`.
- `rooms takedown 4sxi63cd46peqlhzx24ewevqqy` at **02:29:25 UTC** printed `taken down 4sxi63cd46peqlhzx24ewevqqy`.
- After that, `rooms list` no longer had the id, and `reports list` printed `no open reports`.
- The clients saw the close about 3.8 min after the report was filed, which is the time the operator step took.

## Real providers (headed, xvfb)

**Against the hosted prod build** (`OMEGA_WEB_URL=OMEGA_SERVER_URL=https://omega-share.duckdns.org`):
- `M2-vimeo`, `M2-twitch-vod`: play, pause and seek shared across two browsers, spread ≤ 500 ms. Pass.
- `M2-twitch-live` on `shroud`, set through `OMEGA_REAL_TWITCH_LIVE`: the live pill shows and there's no scrubber. Pause arrived at 110/110 ms and play-from-live at 1237/1237 ms, spread 0 ms. Pass. The default candidate list was all offline at 02:40 UTC, so the first run skipped this test.
- `M3-twitch-gate` on `erobb221` (live, mature-gated): both members see the Start Watching hint. Pause and play spread 0 ms. Pass.
- `M2-refused`: the gone, offline and mature-gated embeds each say why and freeze the transport. Pass. The `vimeo-refused` sub-case isn't run, because it needs `OMEGA_REAL_VIMEO_REFUSED`.

**Dev server** (these specs read the dev handle and the server's own headers, so they don't run against the prod build):
- `real-youtube`: 7/7 pass, including the path-scoped CSP widget API, the 1.05 rate rung, sound after Enter, the muted fallback + Unmute with no user activation, the embed-disabled and age-restricted notices, Slow 4G catch-up, and the two-profile spread.
- `real-invite-referrer`: the invite key leaves no trace in Twitch's requests. Pass.

## Gaps (not M7 regressions)

- **`real-ads` quota assert:** it needs 3 live Twitch channels from its list, and at 02:35 UTC only 2 were live (shroud, summit1g). No ads were served on any attempt (8 YouTube, 2 live Twitch). Earlier milestones documented the same time-of-day failure.
- **`real-youtube` and `real-invite-referrer` against the prod build** fail by construction (no dev handle). They passed on the dev server, see above.
- **The tunnel and abuse real specs (14)** skip without a tunnel lane, as in the M6 sign-off.
