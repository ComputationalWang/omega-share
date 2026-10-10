
## Perf: submit, end the run, read the result next wake (OME-819)
Never `sleep`/poll for perf and no `flock … bun run perf`. `bun run perf:submit --issue OME-n [perf/x.perf.ts …]` queues the committed HEAD and returns at once; end the run; on the next heartbeat `bun run perf:result <job>` (exit 2 = still running: end the run again). Details: `docs/ops/perf-runner.md`.

## The walk-tier probe is real timing: a slow box honestly says Basic (OME-871)
An unforced room upgrades to Smooth only if its first 30 renders are fast (`apps/web/src/walk/tier.ts`). On the 4-vCPU CI runner they often aren't, so a spec that needs a *probed* Smooth (not a forced one, which never drops) uses `healthyDevice` in `e2e/m8-walk-tiers.e2e.ts`: it feeds the probe healthy rAF and after-paint timings until `window.__healthy = false`. Repro a slow runner locally with a CDP `Emulation.setCPUThrottlingRate` of 6, not `taskset -c 0`: one CPU makes `hardwareConcurrency` 1, the static gate keeps Basic and the probe never runs.
