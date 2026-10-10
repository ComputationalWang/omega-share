# Perf runner (OME-819)

Perf runs take 5 to 25 minutes. Agent runs end before that, and a background job dies with the run, so agents used to sleep and poll (about 23 h in 10 days). Now an agent **submits a job and ends its run**; a user service on the operator machine works the queue; the agent reads the verdict on its **next heartbeat**. No `sleep`, no `flock`.

## For agents

```
bun run perf:submit --issue OME-123 [--motion smooth|basic] [perf/site.perf.ts ...]   # queues the committed HEAD (or --sha <sha>); returns at once
bun run perf:result <job-id>                                   # next heartbeat. --latest = newest job
```

- `perf:result` exits 0 passed, 1 failed (budget or spec; prints the report), 2 still queued/running (end the run again, don't sleep), 3 unknown job.
- Only the committed sha is measured. Push or commit first; uncommitted changes print a warning and are ignored.
- `--motion smooth|basic` forces the walk tier in every perf context (`OMEGA_PERF_MOTION`, ADR 0037); without it the client picks. Submit one job per tier for a both-tier run.
- No specs = the full perf suite. Specs follow `perf/<name>.perf.ts` (ADR 0036 targeted runs).
- Post the verdict (numbers from `report.md`) into the issue on the wake that reads it.

## How it works

- Queue: `~/.local/state/omega-share/perf-queue/<job>/` (`OMEGA_PERF_QUEUE_DIR` overrides). `job.json` (sha, specs, requester, issue) → `running.json` while it runs → `result.json`, `run.log`, `report.md`, `report.json`.
- One job at a time, oldest first. Own worktree `~/.local/state/omega-share/perf-worktree`; `bun install` and the build only when the sha differs from the last passed job (plus `perf/run.ts` stamps, OME-818).
- Own ports 4470 / 5243 / 8857 (proxy 4500, tunnel servers 8858–8863), so it never collides with an agent lane (4400–4430 / 5173–5203 / 8787–8817, proxies +30, tunnel servers +1…+6).
- A job that throws, exceeds 90 min, or was running when the runner died is reported `failed` with a reason; it never hangs the queue.
- Code: `perf/runner/` (`queue.ts` is unit-tested).

## Operator: install, check, recover

From a checkout of `main` at `~/Projects/omega-share` (the unit runs `perf/runner/serve.ts` from there; after changing the runner, `git pull` that checkout and `systemctl --user restart omega-share-perf-runner`):

```
cp deploy/perf-runner/omega-share-perf-runner.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now omega-share-perf-runner.service
loginctl show-user $USER -p Linger      # must say Linger=yes, or the service doesn't start after a reboot without a login
```

- Status / logs: `systemctl --user status omega-share-perf-runner`, `journalctl --user -u omega-share-perf-runner`; per job: `<job>/run.log`.
- Stuck job: `systemctl --user restart omega-share-perf-runner` fails the running job ("runner stopped") and carries on with the queue.
- Cancel a queued job: delete its directory.
- Reboot check: after a reboot, `systemctl --user is-active omega-share-perf-runner` prints `active`.
