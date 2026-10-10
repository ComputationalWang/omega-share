
## Perf: submit, end the run, read the result next wake (OME-819)
Never `sleep`/poll for perf and no `flock … bun run perf`. `bun run perf:submit --issue OME-n [perf/x.perf.ts …]` queues the committed HEAD and returns at once; end the run; on the next heartbeat `bun run perf:result <job>` (exit 2 = still running: end the run again). Details: `docs/ops/perf-runner.md`.
