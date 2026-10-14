# Server perf baseline (OME-1105)

The reference point for the `ws.ts` refactor: every Server and Load-test row of [`docs/perf-budgets.md`](../perf-budgets.md), measured on `main` before it changes.

- **Commit:** `5714ae024ea633bc1f7e969c268b2f94eca7b5d7` (main, 2026-10-14)
- **Machine:** the shared dev box `omarchy`: AMD Ryzen 7 3700X (8 cores / 16 threads), 31 GB RAM, Linux 7.2. Load average 1.58 at start, 2.47 peak.
- **How:** perf runner job `1791971693179-o5rkwo` (flocked, one pass, PASSED in 42 s):
  `bun run perf:submit --issue OME-1105 perf/server.perf.ts perf/load.perf.ts`, then `bun run perf:result <job>`.
  The runner calls `bun run perf perf/server.perf.ts perf/load.perf.ts` under `flock "$XDG_RUNTIME_DIR/omega-share-perf.lock"`; that command reproduces it directly.

## Results

| Row (perf-budgets.md) | Budget | p95 | Samples and load | Verdict |
|---|---|---|---|---|
| Server: relay latency for a control action, localhost | ≤ 50 ms | **1.3 ms** | control seek → playback at all 25 sockets, p95 of 50. Sit/stand at 25 sockets: p95 0.7 ms | pass |
| Server: relay latency for a control action under flood, localhost | ≤ 50 ms p95 | **1.1 ms** | p95 of 50 seeks at 24 members. Members sent 288 chats, 0 `rate_limited`. Attacker sent 1286, got 24 `rate_limited`, closed with 4029 ×23 | pass |
| Load test: 25 people in a room, relay latency | ≤ 50 ms | **2.5 ms** | 80 sit/stand samples (slowest of 24 bots in one page, client queueing included). 25 members, 1752 chats + 2229 seat changes received, 0 error frames, M3 limits on | pass |
| Load test: 25 people in a room, site frame time | ≤ 16.7 ms | **16.7 ms** | 480 frames, 0 missed vsyncs (0.0 %). Raw p95 16.70 ms is exactly one vsync, so a full-speed frame, not a miss | pass |

Nothing is over budget, so no bug issues were filed.

## Gaps

- **p50 and max are not recorded.** The probe (`apps/server/src/relay-latency.ts`) computes p50, p95 and max, but `perf/server.perf.ts` keeps only p95 in the metric and the runner log doesn't include the probe's stdout. The load spec keeps only p95 as well. To get the full distribution today, run the probe by hand against a running server: `bun apps/server/src/relay-latency.ts --url ws://127.0.0.1:<port>/rooms/<room>/ws --clients 25 --samples 50 --origin <web origin> --budget Infinity --action control [--flood]`. Its last line is JSON with `p50`, `p95` and `max`. Recording p50/max in the spec would be a small `perf/` change for QA, outside this docs-only issue.
- **Server heap / memory has no budget row and no local harness.** `perf-budgets.md` only budgets the *site* JS heap (≤ 150 MB after 10 min). The server exports `process_resident_memory_bytes` on `/metrics` (`apps/server/src/metrics.ts`), but no local perf spec samples it. The only recorded server memory figure is the hosted run in [`m6-hosted-load.md`](m6-hosted-load.md): **RSS max 82.9 MB** on the CAX11 box (release `fad7d5f`, 2026-10-09; that QA doc used a 300 MB budget, which is not in `perf-budgets.md`). That run also recorded server-side relay p50 0.032 ms, p95 0.092 ms, p99 0.171 ms from the relay histogram. A local server-RSS row would need a budget decision first (Lead / QA).
- **Single pass.** As `perf-budgets.md` "Sampling and verdicts" prescribes. Compare the refactor against the same specs, flocked, and allow for normal noise on a shared machine: all three relay numbers are ~20× under budget.
