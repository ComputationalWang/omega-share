# Hosted capacity, restart drill, metrics privacy, TTI (OME-511, M6 Q2)

2026-10-09, hosted box (CAX11, 2 vCPU arm64), release `fad7d5f`. Script: `scripts/hosted-load.ts`. Raw numbers: `hosted-load.json`, `hosted-privacy.json`, `hosted-tti.json`.

## How the load is generated (per-IP caps)

From the operator's machine. A single address may hold only 5 members per room and gets 6 joins before it is paced at 0.2/s, so 25 people per room can't come from one address. Of the 500 clients, 495 go through an ssh tunnel as `deploy` to the app port on the box (127.0.0.1:8787, the same hop Caddy takes). Each of those sends its own `X-Forwarded-For` address from 198.18.0.0/15 (RFC 2544). With `TRUST_PROXY=loopback` the server keys every per-address limit by that address, so each simulated person gets their own buckets. The other 5 clients take the real path, over `wss://` through Caddy and TLS from the operator's address, and that is the address's join burst.

Traffic: chat at 1/s per member (`CHAT_PER_SECOND`), and a `control` seek at 4/s per room (`ROOM_CONTROL_PER_SECOND`) with the actors rotating. Seats 0–7 are taken in every room, and the owner queues 3 YouTube items: 1 plays and 2 wait. The rooms are private (`QA2 load 01–20`) and were deleted afterwards.

```sh
set -a; . ./.env; set +a      # SERVER_IP, DEPLOY_KEY_PATH
bun scripts/hosted-load.ts setup    --state ~/scratch/state.json --rooms 20     # ~10 min: the global create bucket is 10, then 1/min
bun scripts/hosted-load.ts run      --state ~/scratch/state.json --clients 25 --minutes 10 --public 5 --drill --out perf/results/hosted-load
bun scripts/hosted-load.ts privacy  --state ~/scratch/state.json --journal <exported journal> --out perf/results/hosted-privacy.json
bun scripts/hosted-load.ts tti      --runs 5 --out perf/results/hosted-tti.json
bun scripts/hosted-load.ts teardown --state ~/scratch/state.json
```

The box is sampled over the same ssh connection every 10 s: `/metrics` on 127.0.0.1:9464 (the relay histogram and RSS) and `/proc/<pid>/stat` (CPU).

## 20 rooms × 25 clients, 10 min

| | measured | budget |
|---|---|---|
| relay latency p95 (server, 333,861 frames) | **0.092 ms** (p50 0.032, p99 0.171; worst 10 s interval 0.099) | ≤ 50 ms |
| RSS max | **82.9 MB** | ≤ 300 MB |
| CPU, 10 min average (worst 10 s interval) | **23.3 %** (25.7 %) | ≤ 70 % of one core |
| `rate_limited` / errors / unexpected closes | 0 / 0 / 0 (290,712 chats, 48,380 controls) | 0 |
| echo seen by the sender, incl. RTT to the box | chat p95 22.0 ms, control p95 31.0 ms | — |

The interim run at 7 × 25 (175 members) used 10.0 % CPU, so CPU scales with the number of members.

## Restart drill (under the full load)

The drill ran `systemctl restart omega-share` (what `deploy.sh` does). All 500 clients got close code 1012 and reconnected with the web client's backoff. A client counted as back once it saw itself in its old seat, with the same embed, current item and queue.

- 500/500 back, and **160/160 seated clients in their seats**.
- Drop to back: p50 0.43 s, p95 0.56 s, **max 0.62 s** (budget ≤ 5 s). The wss clients took at most 0.62 s, and everyone was back 0.71 s after the restart command.
- First minute on the new process: CPU 25.6 %, relay p95 0.099 ms, RSS 81.3 MB.

## Privacy

- **Metrics** (40 lines, after the run): grepped for 584 needles: every room id, title, owner token and invite key, all 500 nicknames, both simulated address prefixes, the operator's address as the box sees it, and `lobby`. **0 hits, no IPv4/IPv6.**
- **Logs**: the app and Caddy journal for 07:00–08:10 UTC (97 lines, exported as root by the Lead, [OME-578](/OME/issues/OME-578), then deleted). Same needles: **0 hits.** The only address is the server's own `127.0.0.1` bind line, there are no IPv6 addresses and no `"level":"error"` lines, and all 6 restarts were clean.
- **`/metrics` from outside**: `https://<origin>/metrics` serves the SPA, with or without `Host: 127.0.0.1:9464`. `http://<box>:9464` gets no answer (nftables). `/metrics` on the app port returns no metrics, and `Host: localhost:9464` against the app port gets 421.

## Hosted TTI, Chromium "Fast 4G" (measured, not blocking)

DevTools preset: 165 ms latency, 9 / 1.5 Mbps × 0.9. 5 cold-cache runs per page, headless, flocked. Lab TTI as in `perf/site.perf.ts`.

| page | runs (ms) | median |
|---|---|---|
| `/` | 685, 441, 450, 436, 442 | **442 ms** |
| `/rooms/lobby` | 479, 456, 454, 481, 496 | **479 ms** |

The target is < 2.5 s. The first run includes DNS. Sanity check: the same page reaches DCL at 263 ms unthrottled and 513 ms throttled.

## Found on the way

[OME-573](/OME/issues/OME-573): the server capped WebSockets at 200 across the whole server, so 20 × 25 couldn't connect. Fixed in `fad7d5f`: the default is now 1024, and `MAX_CONNECTIONS` sets it.
