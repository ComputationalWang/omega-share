# ADR 0051 — Rust server: two worker threads, CPU gate relaxed to about 35% over Bun

**Status:** accepted (2026-10-15) · board decision on [OME-1169](/OME/issues/OME-1169) · amends the "Better" gate of [ADR 0050](0050-rust-server.md)

## Context

ADR 0050 gate 2 says Rust must beat Bun on p99 and RSS and lose on nothing, with 3 runs agreeing. OME-1169 tuned the release server (socket buffers, one flush per burst, no timer for an immediate write, release profile, worker threads) against `perf/server-compare.ts` defaults (20 rooms x 25 members = 500 sockets, 60 s, `--noise 25`). RSS and p99 pass. CPU does not pass at the same time as p99: the load fires every room in the same tick, so one thread drains about 2000 frames serially, and more threads cut the tail by spending CPU on cross-thread wakeups.

Measured, release build, 3 alternating runs per row (ranges are min to max of the 3 runs; Bun has 6 runs, two series):

| server | p99 ms | RSS avg MB | CPU avg % of one core |
|---|---|---|---|
| Bun | 6.7 to 13.6 | 63.5 to 64.0 | 10.9 to 11.8 |
| Rust, 1 worker (current-thread) | 5.9 to 7.7 | 17.4 to 17.7 | 10.3 to 11.2 |
| Rust, 2 workers | 3.6 to 4.7 | 18.0 to 18.3 | 14.1 to 15.6 |
| Rust, 16 workers (the old default; 1 run, 82.9 MB before the buffer change) | 2.9 to 13.4 (loaded box) | 82.9 | 23.2 to 30 |

Sources: `perf/server-compare.ts` JSON of the final runs, and the baseline in the PR #253 description. The 16-worker row is a single baseline run from before the socket-buffer change, so its RSS is not comparable to the others.

About two thirds of Rust's CPU is in the kernel send path (loopback `write` delivers into the receiving socket inline). Measured from `/proc/<pid>/stat` utime/stime over a 30 s window, for Rust only: Bun was not split the same way, and `perf`/`strace` are not installed on the box. Bun pays the same kernel cost per frame, so user-space work cannot close the remaining CPU gap.

## Decision

1. **Default: 2 worker threads.** `OMEGA_WORKER_THREADS=1` selects the current-thread scheduler: CPU equal to Bun (-13% to +0.3%), p99 equal to Bun, RSS still better. Use it on a one-core box.
2. **Amended gate 2 ("Better")**: p99 and RSS beat Bun, and CPU avg is no more than about 35% above Bun, over 3 alternating runs that agree. At 2 workers the CPU is +24% to +33%.
3. The ADR 0050 "lose on nothing" wording is read with this one exception.

## The knob

`OMEGA_WORKER_THREADS`: a whole number from 1 to 256 (anything else exits with "invalid OMEGA_WORKER_THREADS: expected a whole number from 1 to 256"). Read only in release builds; it is a process knob, not part of `CONFIG_KEYS`. The `test-hooks` build always runs on one thread. Blocking threads are capped at 32 on either runtime, so the spawn cannot fail under systemd `TasksMax=256`.

## Consequences

- Bursty rooms keep the p99 win (about 40% to 50% lower than Bun) at about 30% more CPU than Bun, on a load that is about 11% of one core.
- Revisit if the box becomes CPU-bound: set `OMEGA_WORKER_THREADS=1`, no rebuild.
