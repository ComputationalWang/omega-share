# ADR 0020 — Hosted topology: one VPS, Caddy in front, systemd, DNS-only

**Status:** accepted (2026-10-08) · [OME-356](/OME/issues/OME-356) · board decision on approval [11cf51a5](/OME/approvals/11cf51a5-c38d-4cab-9d52-f9fdbf3710d1) · research `docs/research/m4-hosting-and-sqlite.md` · **supersedes the tunnel part of [ADR 0015](0015-public-tunnel-and-share-token.md) §1** (items 2–9 of ADR 0015 still hold)

**Context:** In M2 and M3, the public deploy was an operator-run ngrok tunnel. It only ran while a session lasted. M4 puts omega-share online around the clock. The board picked a Hetzner Cloud **CAX11** (Arm64/aarch64, 2 vCPU, 4 GB, 40 GB local disk, Ubuntu 26.04 LTS, about €7.25 a month plus IPv4) over the Oracle free trial, and a free DuckDNS name. The board holds the Hetzner and DuckDNS accounts.

## Decision

1. **Topology.**
   ```
   client ──TLS──▶ Caddy :443 (same box) ──http──▶ 127.0.0.1:8787 apps/server (Bun, systemd)
                   ACME cert, h1/h2, zstd/gzip       serves apps/web/dist + API + /rooms/:id/ws
   ```
   The server stays the single origin from ADR 0015 §1. Only Caddy changes, replacing the tunnel. Caddy's peer is loopback, so `TRUST_PROXY=loopback` and the rightmost-XFF rule (ADR 0015 §5, ADR 0018 §3) work unchanged. Caddy appends the real peer, and it ignores a client's XFF because no `trusted_proxies` is configured. Every M3 limit keys on the real client.
2. **DNS-only, no CDN proxy.** `omega-share.duckdns.org` is a plain A record. Putting Cloudflare (or any CDN) in front would make the rightmost XFF entry an edge address and would need a new trust mode. If that is ever needed, it takes a new ADR.
3. **Caddy owns TLS and nothing else.** It doesn't set CSP or security headers (the server does, `headers.ts`). It writes no access log, so no IPs go to disk (research D6). Its admin API is off: the app's sandbox may open loopback TCP, and that API could rewrite Caddy's config and read its keys. HTTP/3 is off because the firewall is TCP-only. Port 80 only serves ACME and redirects. Caddy comes from Caddy's signed apt repo, because Ubuntu's package is years old, and unattended-upgrades also takes that origin.
4. **Arm64 is a non-issue for us.** Bun has official `linux-aarch64` builds. The server's runtime dependencies (hono, valibot) and `bun:sqlite` are pure JS or built into Bun. The full server and shared test suite passed on the box (OME-356). The release ships `node_modules` built off-box, which is safe because there is no native addon. If a native dependency is ever added, it must be built for aarch64 in CI.
5. **Pinned runtime.** `.bun-version` pins Bun. `provision.sh` installs exactly that version from the GitHub release, checks it against the SHA-256 committed in `deploy/bun-linux-aarch64.sha256` (not a checksum fetched from the same place as the binary), and installs it root-owned at `/usr/local/bin/bun`. `deploy.sh` refuses to run if the local or the box's Bun differs from the pin. A Bun upgrade is a commit to `.bun-version` and the hash file, plus an admin re-run of `provision.sh base`.
6. **Build off-box, never on the box.** `deploy/deploy.sh` builds the site and the server's production `node_modules` locally (or in CI). It rsyncs the release to `/opt/omega-share/releases/<commit>`, flips the `current` symlink atomically, restarts the unit and checks `/healthz`, putting the previous release back if it fails. The site is built from `git archive` of the commit, so ignored files and local env never ship. It keeps the 5 newest releases. To roll back, point `current` at an older release and restart (`docs/ops/hosting.md`). A restart drops sockets for a moment. Clients reconnect with backoff, and playback state is lost, as accepted in research §2.4.
7. **Least-privilege accounts.**
   - `omega-share` is a system user with no login. It runs the server and owns `/var/lib/omega-share`.
   - `deploy` (deploy key) owns `/opt/omega-share`. It can start, stop and restart **only** `omega-share.service` (a polkit rule), and it can read the backups. It has no sudo.
   - `admin` (a separate admin key) has passwordless sudo and is the only root path.
   - Root login and password authentication are off, and only `deploy` and `admin` may use SSH. Both private keys are board-held and go into Paperclip secrets. Agents don't run sudo (company rule), so root-level changes after go-live are made by the operator as `admin`, by re-running `deploy/provision.sh`.
8. **systemd hardening (research D7).** The unit sets `ProtectSystem=strict`, `ReadWritePaths=/var/lib/omega-share` only, `NoNewPrivileges`, an empty capability set, `PrivateTmp`, `PrivateDevices`, `ProtectHome`, kernel and cgroup protection, `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX`, `SystemCallFilter=@system-service`, `UMask=0077`, `MemoryMax=512M` and `TasksMax=256`. The DB is outside the release and outside `STATIC_DIR` (D5, also checked at startup).
9. **Firewall, in two layers.** The Hetzner firewall allows TCP 22, 80 and 443 only. On the box, nftables drops by default, accepts 22 with a per-source rate limit on new connections (per /64 on IPv6; meter entries expire after 5 minutes), and accepts 80 and 443 with **at most 64 concurrent connections per source address** (per /64 on IPv6), which is the per-IP cap the board approved. `provision.sh` loads the ruleset with an automatic 3-minute rollback until a fresh SSH session confirms it.
10. **Unattended upgrades.** These cover Ubuntu security plus Caddy, with an automatic reboot for kernel updates at 04:30 UTC. The unit is enabled, so the server comes back after a reboot.
11. **Backups.** A systemd timer runs at 03:15 UTC (± 10 min), as the service user. It takes a `VACUUM INTO` snapshot, checks `PRAGMA integrity_check`, and keeps 14 days in `/var/backups/omega-share`. The off-box copy is `deploy/pull-backups.sh`, which rsyncs the snapshots as `deploy` to the operator's machine and keeps 60 days there. The operator machine runs it from a daily user timer. The restore drill is in `docs/ops/hosting.md` and was run on go-live. The data is low-sensitivity: rooms, layouts and last embeds, with no IPs, chat or names.
12. **The tunnel stays as a documented fallback** (`docs/ops/tunnel.md`, ADR 0015). It is only for local sessions, never in front of the hosted box.

## Consequences

- No application code changed for hosting. The tested proxy model is the one in production.
- A leaked deploy key gives control of the app's code and service (inside the sandbox), but not root. A leaked admin key is root. Rotating either key means editing `authorized_keys` as admin.
- One box, one region (Germany). The latency to US users (about 90–150 ms RTT) is far inside the sync budget.
- The hosted perf numbers are informational only. The merge-blocking budgets stay on localhost (`docs/perf-budgets.md`).
- Moving to another VM means running `provision.sh` on it, then `deploy.sh`, copying the latest snapshot to `DB_PATH`, and pointing the DuckDNS record at it.
