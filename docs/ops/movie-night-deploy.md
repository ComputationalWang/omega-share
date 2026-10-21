# Movie night: big-batch deploy runbook, hosted smoke checklist, daily-suite rows (OME-1647)

For [OME-1649](/OME/issues/OME-1649) (deploy + smoke + soak) and [OME-1648](/OME/issues/OME-1648) (sign-off). Owner: QA Engineer 2. Background: [switch-to-rust.md](switch-to-rust.md) (setup, `D=`/`A=` variables, rollback), [hosting.md](hosting.md), [backup.md](backup.md), [perf-runner.md](perf-runner.md). Setup in every command below: `set -a; . ~/Projects/omega-share/.env; set +a; A="-o IdentitiesOnly=yes -i ~/.config/omega-share/admin-key"; D="DEPLOY_HOST=deploy@$SERVER_IP DEPLOY_KEY=$DEPLOY_KEY_PATH"; ORIGIN=https://omega-share.duckdns.org`.

The batch ships many changes at once: relay batching (`batch` frame, per-connection opt-in `join.batch`, OME-1583), reaction timeline in the snapshot, `watchingCount`/`nowPlaying` in the rooms list, share `startSeconds`, countdown start. **Server first, behaviour second:** relay batching is the one change that touches every room, so it carries a kill switch.

## Rollback triggers (any one, at any stage)

| Trigger | How to see it | Action |
| --- | --- | --- |
| **Panic** | `journalctl -u omega-share --since <deploy time> -o cat \| grep -ci panic` > 0, or the service restarted by itself | Roll back (below). File a top-priority blocker for the owner and tell the CEO: the board decides on the Bun fallback, never run `--server bun` yourself. |
| **Restart loop** | `systemctl show omega-share -p NRestarts` is above 0 after the deploy's own restart, or `ActiveEnterTimestamp` keeps moving | Roll back. |
| **Rising RSS** | `process_resident_memory_bytes` sampled every 10 s over the soak has a positive slope (the soak fails loudly on it), or > 300 MB (budget) | Roll back, unless the kill switch below flattens it. |
| **Batching misbehaves** (relay p95 > 50 ms, clients out of sync > 500 ms, a missing or reordered frame, an abnormal `omega_ws_closes_total`) | `relayHistogram` p95 (see § 3), the smoke rows 7–8 | **Kill switch first: `RELAY_BATCH_MS=0`** (no coalescing; opted-in clients keep working and get single frames). Restart, repeat the failing smoke row. Still red: roll back. |
| `/healthz` not 200, or `deploy.sh` rolls back by itself | `curl -sI $ORIGIN/healthz` | Nothing to do: it restored the previous release. Read the log, file the blocker. |

**Kill switch** (as `admin@`; the unit reads `/etc/omega-share/env`, `EnvironmentFile=-` in `deploy/omega-share.service`):

```sh
ssh $A admin@$SERVER_IP 'echo RELAY_BATCH_MS=0 | sudo tee -a /etc/omega-share/env >/dev/null && sudo systemctl restart omega-share'
ssh $A admin@$SERVER_IP 'systemctl show omega-share -p NRestarts; curl -s http://127.0.0.1:9464/metrics | grep -c omega_relay_latency'   # expect the process to answer
```

Undo by removing the line and restarting. Check the exact variable name and its default against the merged OME-1583 code (`grep -rn RELAY_BATCH_MS apps/server-rs/src`) before the deploy; if it differs, fix this page in the same PR as the deploy. A restart closes sockets with 1012 and clients reconnect into their seats, so the kill switch costs users about 1 s.

**Rollback** is the previous Rust release, not Bun: `ssh $A deploy@$SERVER_IP 'ls -1t /opt/omega-share/releases'` shows the last good `<sha>-rust`; flip `current` to it and `systemctl restart omega-share`, or re-run `env $D deploy/deploy.sh --server rust` from a checkout of that SHA. No migration may ride in this batch without a snapshot restore plan (switch-to-rust.md § 4, backup.md § Restore): check `git diff <live sha>..main -- apps/server-rs/migrations` first.

## 1. Before the deploy (from QA2's clean detached checkout of the signed-off `main` SHA)

1. OME-1648 is done on **this SHA**: `bun run check` green and CI `check` + `e2e` green on `main`, the full local suite and flocked perf (both tiers) green, Pixel 7 `walk25.conga` ≤ 8 ms.
2. Note the live SHA (footer `version …`, or `ls -l /opt/omega-share/current`) as the rollback target, and the live numbers: `omega_rooms`, `omega_sockets`, `process_resident_memory_bytes`, `NRestarts`.
3. `env $D deploy/deploy.sh --server rust --dry-run` lists the steps.
4. Snapshot and verify (switch-to-rust.md § 0.5). Stop unless `verify` prints `ok`.
5. Pick a quiet time: the deploy restarts the server (clients reconnect in about 1 s).

## 2. Deploy (staged)

| Stage | Command | Gate to continue |
| --- | --- | --- |
| A. Ship | `env $D deploy/deploy.sh --server rust` | `/healthz` 200 (the script waits and rolls back by itself). Footer shows the new SHA. |
| B. Quiet check (2 min) | `journalctl -u omega-share -n 60 -o cat` and `systemctl show omega-share -p NRestarts` | No `"level":"error"`, no `panic`, no `status=31/SYS`, `NRestarts=0`. `omega_rooms`/`omega_sockets` back to the pre-deploy values after the reconnects. |
| C. Smoke | § 4 below, 4 browser contexts, headed on xvfb | Every row passes. Evidence in the report. |
| D. Soak | § 3 below, 30 min | Pass criteria of the soak plus the relay numbers. |
| E. Report | Post the SHA, smoke results and soak numbers on OME-1649, mark it done | Wakes the CEO on OME-1616. |

A failure at B, C or D means: apply the trigger table, stop, and do not proceed to the next stage.

## 3. 30-minute soak on the box and the relay counters

From the operator machine, over the same ssh path as `scripts/hosted-load.ts` (it samples `/metrics` on 127.0.0.1:9464 and `/proc/<pid>/stat` every 10 s). A 30-minute local binary soak ran at OME-1645; the hosted soak below watches the live process under a modest load:

```sh
bun scripts/hosted-load.ts setup --state $PAPERCLIP_RUN_SCRATCH_DIR/state.json --rooms 4
bun scripts/hosted-load.ts run --state $PAPERCLIP_RUN_SCRATCH_DIR/state.json --clients 10 --minutes 30 --public 5 --out perf/results/movie-night-hosted
bun scripts/hosted-load.ts teardown --state $PAPERCLIP_RUN_SCRATCH_DIR/state.json
```

It writes `relayHistogram` p50/p95/p99 per 10 s interval, RSS and CPU. (Run `setup` early: the global create bucket paces rooms.)

Pass: relay p95 ≤ 50 ms (the server-side number; `hosted-load` computes it with `relayHistogram` + `histogramQuantile` from `omega_relay_latency_seconds`), RSS flat (last 10 min slope ≤ 0, max ≤ 300 MB), CPU ≤ 70 % of a core, `NRestarts` 0, no `panic`/`error` in the journal, `rate_limited`/errors/unexpected closes 0. Compare with the pre-batch hosted run in [m6-hosted-load.md](../qa/m6-hosted-load.md) (p95 0.092 ms, RSS max 82.9 MB at 500 clients): **batching must lower relay count, not raise p95 or RSS**. If the metric gains new counters (frames per batch, batches sent), record their before/after in the report.

## 4. Hosted smoke checklist: Movie night, 4 contexts

Headed Chromium on xvfb (board rule, never on the desktop): `env -u WAYLAND_DISPLAY -u ELECTRON_OZONE_PLATFORM_HINT -u XDG_BACKEND OZONE_PLATFORM=x11 XDG_SESSION_TYPE=x11 xvfb-run -a <command>`. Four browser contexts **A** (owner), **B**, **C** and **D** (D joins late). Use a private room (`QA2 smoke <date>`), delete it afterwards. Use a ≥ 3 min YouTube video so replay and recap have something to show. Record each row pass/fail with a screenshot or trace in `docs/qa/movie-night-hosted/`.

| # | Row | Steps | Pass |
| --- | --- | --- | --- |
| 1 | Join | A, B, C open the room URL through `$ORIGIN` (real TLS path) | All three see each other; no reconnect banner; opted-in batching is active (`join.batch` frames arrive as `batch`: check the WebSocket frames in the trace). |
| 2 | Sit | A, B, C sit in the theatre rows (apply the theatre preset on A) | Each sits facing the screen; the others see it within 500 ms; seats are not double-booked. |
| 3 | React | B and C send reactions (several per second for 5 s, then stop) | Glyphs appear on every context, throttled by the limit (no `rate_limited` flood, no jank), nothing leaks into the chat log. |
| 4 | Late-join replay | D joins after row 3 | D's moments strip / catch-me-up shows the reactions in order with the right timestamps (server-stamped), nothing duplicated, within 2 s of joining. |
| 5 | Countdown start | A starts the shared 3-2-1 with a shared video | All contexts show the overlay in step (≤ 500 ms apart) and playback starts together; a context that joins mid-countdown shows the remaining count. |
| 6 | Share at a time | In the real extension (popup, loaded unpacked) on a video page at ~1:30, "start where I am"; also the one-click share | The room's video starts at the shared time (± 2 s); the rooms list shows `watchingCount` and `nowPlaying` for the room (and the extension badge, if landed). |
| 7 | Play / pause / seek | A plays, pauses, seeks forward and back while B, C, D watch | Every context follows within **500 ms** (measure from the control click to `getCurrentTime` on each; the e2e sync spec's method). Repeat once right after row 3's reaction burst. |
| 8 | Recap | Let the video end (or seek to the last seconds) | The recap card appears on every context with the same numbers, dismisses cleanly, and the next queue item (if any) starts. |
| 9 | Reload | Reload B mid-video | B returns to its seat, same embed and position, reaction timeline intact. |
| 10 | Kill switch (once, after the other rows) | Set `RELAY_BATCH_MS=0`, restart; repeat rows 1, 7 | Still in sync, no console errors; undo the switch and restart again; confirm batching is back. Skip this row only if the deploy has already been rolled back. |

Also during the smoke: `journalctl -u omega-share -p warning --since <deploy time>` is empty, and the browser consoles of all four contexts have no errors.

## 5. The daily 02:00 suite: rows this batch adds

Owner: QA Engineer 2 (daily run on `main`, filed by the CEO routine). Everything below is added to the existing daily list (`bun run check`, local e2e lanes, flocked perf, 30-minute soak until 2026-10-22); each red row is a top-priority blocker issue naming the merge (bisect first).

| Row | How | Red when |
| --- | --- | --- |
| Movie night e2e | The e2e specs from OME-1644 (replay timing, reaction safety) and the lanes that already cover sync, countdown, rooms list and share-at-time, in `bun run e2e` / `e2e-sync` | any failure |
| Movie night perf rows | The OME-1643 rows (theatre, reaction burst, 10-minute heap) in the flocked perf run, both motion tiers, plus `walk25.conga` | any budget in `docs/perf-budgets.md` exceeded (Pixel 7 Smooth ≤ 8 ms) |
| Black-box and corpus | `bun run blackbox` and the manifest; the non-opt-in byte-identical check (OME-1645) | a manifest test fails, or frames for a non-opted-in client differ |
| **Relay counters** | In the 30-minute soak and `perf/server-compare.ts` output, read `omega_relay_latency_seconds` through `relayHistogram` + `histogramQuantile` (`scripts/hosted-load-lib.ts`); record p50/p95/p99, count and sum, and the batch counters if present | relay p95 > 50 ms; p95 worse than the previous green day by more than 2× (watch the trend, not only the budget); count per frame not falling vs the no-batch baseline; a histogram that is empty or missing (the counters broke) |
| Kill switch | Run the soak's first 2 minutes once with `RELAY_BATCH_MS=0` and compare to the batched run (weekly is enough) | the switch changes nothing, or a restart is needed to see it |
| Hosted spot check | A 4-context smoke of rows 1, 2, 5 and 7 against `$ORIGIN` (headed, xvfb), only on days a deploy happened | any row |

A smoke *script* for § 4 (the 4-context hosted run) belongs under `e2e/**`; QA Engineer owns that path, so it is filed as a sub-issue to QA Engineer rather than written here. Until it lands the checklist is walked by hand.
