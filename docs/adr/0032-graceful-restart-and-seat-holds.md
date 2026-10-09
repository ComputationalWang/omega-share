# ADR 0032 — Graceful restart, seat holds and the metrics endpoint

**Status:** accepted (2026-10-09) · Server Engineer · [OME-504](/OME/issues/OME-504) · plan [OME-499](/OME/issues/OME-499) (S3) · builds on [ADR 0016](0016-m3-limits-names-and-close-codes.md) (close codes), [ADR 0020](0020-hosted-topology.md) (the box) and [ADR 0028](0028-room-ownership-and-private-rooms.md)

**Context:** M6 wants deploys and restarts that people barely notice: clients reconnect on their own and are back in their seats with the same embed within 5 s. Rooms, layouts and embeds already persist (SQLite). Seats, members and share tokens are memory-only, and a member's id is new on every join, so a restarted server can't tell who sat where. The web client and extension must keep working unchanged, and the contract (`packages/shared`) doesn't change. M6 also wants metrics on the box with no personal data, and error logs with rotation.

## Decision

### 1. SIGTERM drains; the close code is 1012
- On SIGTERM (or SIGINT) the server stops listening, closes every socket with **1012 "Service Restart"** (RFC 6455), waits up to 3 s for the closes, saves seat holds (§2), checkpoints the WAL, closes the database and exits 0. systemd sends SIGTERM on `restart` and `stop` (`KillSignal=SIGTERM`, `TimeoutStopSec=10s`).
- 1012 is a standard code, not one of `CLOSE_CODES` (4000–4999), so the contract doesn't change. The web client treats any code it doesn't know as a network drop: it reconnects with its usual jittered backoff (first try after 250–500 ms) and rejoins under the same nickname. Adding 1012 to `CLOSE_CODES` later is a contract issue for the Lead, but nothing needs it.

### 2. Seat holds, by name hash, for 30 s
- At drain the server records each seated member as `(room id, SHA-256(nicknameKey), seat)` in the `seat_holds` table (migration 0003). **No nickname, member id or address is stored.** At the next boot it reads the rows and deletes them in one transaction, so a hold is used by one boot at most and rows live on disk only for the length of a restart. A nightly backup taken in that window could hold them. A nickname is short and could be guessed back from its hash, so the hash only stops casual reading. That is acceptable for rows that exist for seconds.
- A member who joins within **`SEAT_HOLD_MS` = 30 s** of the boot with a name whose `nicknameKey` matches (case and lookalikes fold, as for nickname uniqueness) gets the seat back, if it is still free. Its snapshot shows it seated. The room gets `member-joined`, then `seat-changed`. A hold is spent at the first matching join. A seat someone else took first stays theirs.
- Someone else joining under the same name inside those 30 s would get the seat. That's the same trust as nickname uniqueness today (first to join holds the name), and an empty seat is all they get.
- A crash (SIGKILL, OOM) writes no holds: people come back standing, which is today's behaviour.

### 3. Metrics on their own loopback port
- `METRICS_PORT` (unset or `off`: no listener; the box uses 9464) serves `GET /metrics`, Prometheus text format 0.0.4, **on 127.0.0.1 only**. The bind address isn't configurable, the Host header must be `127.0.0.1:<port>` or `localhost:<port>` (421 otherwise), and Caddy never proxies the port. The deploy kit test checks that the Caddyfile's only upstream is the app port and that nftables doesn't open it.
- Series: `omega_rooms`, `omega_sockets`, `omega_members`, `omega_relay_latency_seconds` (histogram of the server's time from a frame's arrival to its fan-out), `omega_ws_closes_total{code}` for the codes the server sends (4001, 4002, 4004, 4029, 4400, 1012), `process_resident_memory_bytes` and `process_uptime_seconds`. No label or value names an address, nickname, room id or title. The test checks every line against a fixed shape.
- Cost on the relay path: two `performance.now()` calls and a bucket increment per frame, with no allocation.

### 4. Error lines are JSON with fixed event names
- `logError(event, err)` writes one JSON line to stderr: `{"level":"error","event":"store.title","error":"Error: …"}`. Events are a closed union. The message is cut at 240 chars, and quoted values (store and Valibot errors quote ids and input), IPv4/IPv6 addresses and emails are redacted. No call site passes a room id, title or nickname.
- systemd hands stderr to journald. Rotation is in `deploy/journald/omega-share.conf`: 14 days, at most 256 MB in total, files rotated at 32 MB or daily.

## Consequences
- `systemctl restart omega-share` (and so `deploy.sh`) puts people back in their seats with the same embed. Playback restarts paused at 0, as after any restart (ADR 0028). Locally a drain plus a reboot is under 1 s. On the box it is Bun's boot time plus the client's backoff.
- Reading metrics needs a shell on the box (`docs/ops/hosting.md`). Nothing outside can reach them.
