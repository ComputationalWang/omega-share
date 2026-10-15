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

## Follow-up: room-sharded WebSocket threads (OME-1173, not adopted)

Idea: give each room a home thread (N shard threads, each a current-thread runtime; a connection's task runs on the shard that owns its room) so a publish never wakes another thread, while different rooms still use different cores. Built behind `OMEGA_WS_SHARDS=N` and measured; the board decided not to merge it. Code: closed PR #259, branch `board/OME-1173-room-shards`.

Release build, `perf/server-compare.ts` defaults (500 sockets), 3 alternating runs, min to max. `m1` is one main-runtime thread (`OMEGA_WORKER_THREADS=1`).

| server | p95 ms | p99 ms | max ms | RSS avg MB | CPU avg % | CPU peak % |
|---|---|---|---|---|---|---|
| Bun | 4.03-4.51 | 6.39-6.86 | 10.9-11.3 | 63.6-64.0 | 10.9-11.3 | 40-48 |
| Rust, 2 workers (the default) | 1.91-2.16 | 3.30-3.89 | 5.8-8.1 | 18.5-18.6 | 14.1-14.8 | 32-44 |
| 2 shards + m1 | 1.92-2.28 | 3.52-3.87 | 8.0-9.4 | 18.2-18.3 | 14.4-14.8 | 36-40 |
| 4 shards + m1 | 1.98-2.27 | 3.29-3.52 | 4.4-7.6 | 18.4-18.6 | 15.6-16.2 | 40-48 |

Skewed run (`--rooms 4`, 100 sockets, 3 runs):

| server | p99 ms | CPU avg % | CPU peak % |
|---|---|---|---|
| Bun | 1.08-2.07 | 2.8-3.1 | 12-20 |
| Rust, 2 workers | 1.01-2.10 | 3.2-3.3 | 12 |
| 2 shards + m1 | 1.55-2.19 | 3.0-3.2 | 8 |
| 4 shards + m1 | 1.01-1.91 | 3.2-3.3 | 8-12 |

Conclusion: CPU is equal or slightly higher than two workers, p99 and RSS are the same. Sharding adds a runtime per shard, a new shutdown path and an `App` and `Shards` ownership cycle for no measured gain.

Cause (unverified: `perf` is not installed, so no profiler confirmed it): pinning rooms removed the cross-thread handoff on the relay path, yet CPU did not fall to the one-thread level (10.3-11.2 %). The step from one thread to two or more is probably per-thread park and unpark under the bursty load (fewer frames batched per wakeup), not work-stealing handoff.
