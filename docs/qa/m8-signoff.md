# M8 sign-off: full suite, flocked perf (both tiers), deploy, hosted smoke, Firefox (OME-734)

Everything ran on one SHA: **`main` @ `d416fd4`** (M8 Q1 final report; includes the OME-791, OME-802, OME-809 and OME-801 fixes). It ran 2026-10-10/11 from QA2's clean, detached checkout on QA2's ports (4410/5183/8797), headless Chromium unless noted. Real-provider checks ran headed on xvfb (board rule). Perf ran under the machine-wide perf lock, once per forced motion tier.
Raw evidence: [`m8-signoff/`](m8-signoff/) (perf reports for both tiers).

| Gate | Result |
|---|---|
| `bun run check` | **5084 pass, 1 skip, 0 fail** |
| Full e2e (`CI=1 bun run e2e`: e2e, e2e-sync, e2e-tunnel) | **306 passed, 0 failed, 0 flaky** |
| Flocked perf, Smooth tier (job `1791675041323-4dzxhk`) | **134 passed, 0 failed, 1 pending** (soak) — [report](m8-signoff/perf-report-smooth.md) |
| Flocked perf, Basic tier (job `1791675041339-va0f95`) | **134 passed, 0 failed, 1 pending** (soak) — [report](m8-signoff/perf-report-basic.md) |
| Firefox lane (`bun run ext:firefox`, X1) | **81 unit pass, 4/4 e2e, 2/2 perf**. Popup → embeds listed p95 89 ms (≤ 300), 0 content scripts, 0 persistent background |
| Deploy `d416fd4` (as `deploy@`) | live, public `/healthz` 200 |
| Hosted smoke (M8) | **6/6**: forced Smooth vs Basic walk (252 vs 28 steps, same final transform, arrival delta 80 ms); OME-809 two back-to-back lines both float; OME-791 neighbouring bubbles don't overlap; emote wheel (T, menu, keyboard pick, badge on the other client, focus returns); no CSP errors |
| Hosted real providers, headed on xvfb | Vimeo, Twitch VOD, Twitch live (`shroud`), refused embeds: **pass**. Twitch mature gate passes with `erobb221` (as in M7) |

## Perf on d416fd4 (both tiers, budgets in `docs/perf-budgets.md`)

- **Walking, 25 members** (desktop Chromium and Pixel 7 emulation, Basic and Smooth): frame p95 16.7 ms, main thread p95 2.3–4.7 ms (≤ 8), 0.0 % missed vsyncs, on all four rows per tier.
- **Popped-out room** (tab and window): main thread p95 0.8–4.9 ms, 0 missed vsyncs.
- **Sync spread:** YouTube ≈ 1 ms, Twitch VOD 14.8–16.5 ms, Twitch live 13.5–15.5 ms, Vimeo 14.7–15.0 ms (≤ 500). Queue advance 51 ms (Smooth run) / 219 ms (Basic run) (≤ 1500).
- **Relay:** control 1.0 ms, under flood 0.9–1.1 ms; 25 in a room with traffic p95 2.3–2.6 ms (≤ 50).
- **Extension popup:** Chromium 54–59 ms, Firefox 89 ms (≤ 300).
- **Landing:** 48.2 KB gz transfer (≤ 120), LCP 56–64 ms, CLS 0.037–0.041 (≤ 0.05), longest task 0 ms.

## Caveats

- **Soak not run on this SHA.** The 10-minute heap soak shows PENDING in both reports (it is opt-in, `--soak`). The last soak (M7 sign-off) read 5.3 MB (≤ 150); no M8 change touches long-lived room state outside the bubble pool, which the chat-burst rows exercise. Run `bun run perf --soak` if you want it recorded.
- **Soak recorded later (OME-902), on `15ef69b`:** `bun run perf --soak` (flocked, headless) read **5.6 MB** JS heap after the 10 min soak (start 4.3 → end 5.6 MB; 119 chats + 119 seat clicks from the site, bots saw 6114 chats, 4277 seat changes, 46 joins) — PASS ≤ 150 MB. That run was unforced-tier; 120 passed, 1 failed: `chat.perf.ts:80` hit `browser.startTracing: Peer disconnected` (harness trace drop, first test of the run, not a budget miss; the same row passed on both forced tiers in the M8 reports).
- **Twitch gate is channel-dependent:** on `angellxgod` one member's Start Watching also lifted the other's gate (Twitch-side behaviour). Not a product defect.
- The hosted `POST /rooms` rate limit (429) forced reuse of QA2's own empty smoke room for the final run.

**Verdict: green.** M8 can be signed off.
