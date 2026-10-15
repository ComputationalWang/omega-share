# Runbook: switch the hosted box from Bun to the Rust server

Decision: ADR 0050 (stage "Stable": production with the Bun release kept for instant rollback for 7 days, no new migrations in that window) · kit: [OME-1174](/OME/issues/OME-1174) · background: [hosting.md](hosting.md), [backup.md](backup.md). **This document is for the board; nothing in it has been run.** Setup as in hosting.md: `set -a; . ~/Projects/omega-share/.env; set +a`, `A="-o IdentitiesOnly=yes -i ~/.config/omega-share/admin-key"`, `D="DEPLOY_HOST=deploy@$SERVER_IP DEPLOY_KEY=$DEPLOY_KEY_PATH"`.

## What changes on the box

| Root-owned file (installed by `provision.sh base`) | Change |
| --- | --- |
| `/etc/systemd/system/omega-share.service` | now the **Rust** unit (`omega-server serve`, hardened) |
| `/etc/systemd/system/omega-share-bun.service` | new: the old Bun unit, for the rollback window |
| `/etc/systemd/system/omega-share-backup.service` | runs `/opt/omega-share/current/bin/omega-ops backup snapshot` |
| `/etc/polkit-1/rules.d/50-omega-share-deploy.rules` | `deploy` may start/stop/restart both units |
| `/etc/caddy/Caddyfile` | header size and timeouts for the upstream (via `provision.sh logs`, also run by `base`) |

`/etc/sudoers.d/omega-backup` (the off-box pull's rsync sender) does not change. Everything under `/opt/omega-share/releases` is deploy-owned and changes only by deploys.

## 0. Pre-checks (from a clean checkout of the commit to ship)

1. The tools: `scripts/install-server-rs-tools.sh`, then put the PATH line it prints into the shell. Versions and checksums are in `deploy/server-rs-build.env`.
2. `D=... deploy/deploy.sh --server rust --dry-run` lists every step: build, artifact checks, rsync, flip, restart, rollback.
3. The 24 h local soak under load passed (ADR 0050, stage "Stable"), and no migration is pending between the Bun and the Rust schema.
4. **Ship a Bun release made by this kit**, so the 7-day rollback target has the launcher and survives pruning: `env $D deploy/deploy.sh --server bun` (a no-op restart for users).
5. Take a snapshot and check it: `ssh $A admin@$SERVER_IP 'sudo systemctl start omega-share-backup.service && sudo -u omega-share /opt/omega-share/current/bin/omega-ops backup verify $(ls -1t /var/backups/omega-share/omega-*.db | head -n 1)'`, and pull it off-box with `deploy/backup/pull.sh`.

## 1. Root step: provision the two units

```sh
rsync -a -e "ssh $A" deploy/ .bun-version admin@$SERVER_IP:omega-deploy/
ssh $A admin@$SERVER_IP 'sudo bash omega-deploy/provision.sh base'   # then, from a NEW ssh session within 3 minutes: sudo bash omega-deploy/provision.sh firewall-ok
```

`base` is idempotent. It installs both units, enables both (each starts only when `current` holds its server, so there is no clash at boot), reloads polkit and Caddy. The running Bun process is untouched until the next restart. Check `ssh $A admin@$SERVER_IP 'systemctl cat omega-share | grep ExecStart; systemctl is-enabled omega-share omega-share-bun'` and `caddy validate` (the script does it: a Caddyfile that does not validate stops `base` before Caddy restarts).

## 2. Deploy the Rust release

```sh
env $D deploy/deploy.sh --server rust
```

It builds, runs the artifact checks (a failing binary is never uploaded), ships `releases/<sha>/omega-server`, flips `current`, stops `omega-share-bun`, restarts `omega-share`, waits for `/healthz` and rolls back to the previous release **and unit** by itself if it does not answer. Sockets close with 1012 and clients reconnect into their seats.

## 3. Verify

1. Public: `curl -sI https://omega-share.duckdns.org/healthz` is 200 with the security headers; `ssh $A admin@$SERVER_IP 'journalctl -u omega-share -n 40 -o cat'` has no `"level":"error"` line, no `status=31/SYS` (blocked syscall) and no `panic`.
2. Metrics over ssh as in hosting.md: `omega_rooms` and `omega_sockets` back to the pre-switch values after the reconnects, `process_resident_memory_bytes` flat.
3. **A real join through the public origin**: open the site in a browser, join a room, share a video from the extension, watch two clients stay in sync, reload one (it returns to its seat).
4. **The proxy's X-Forwarded-For, forged** (the server reads the rightmost entry and exempts loopback keys from per-key limits, so a proxy that passed a client's header through would let anyone claim loopback): from outside the box, `for i in $(seq 1 400); do curl -s -o /dev/null -w '%{http_code}\n' -H 'X-Forwarded-For: 127.0.0.1' https://omega-share.duckdns.org/rooms; done | sort | uniq -c` must show 429s. All 200 means Caddy kept the client's header: stop and roll back. Caddy's documented behaviour (2.5+, no trusted proxy configured) is to drop the client's `X-Forwarded-*` and set `X-Forwarded-For` to the peer, which is why the Caddyfile has no `trusted_proxies` and no `header_up` for it.
5. Caddy limits: `curl -s -o /dev/null -w '%{http_code}\n' -H "X-Pad: $(head -c 20000 /dev/zero | tr '\0' a)" https://omega-share.duckdns.org/healthz` is 431 (Caddy's `max_header_size 12KiB`; the server itself refuses more than 16 KiB).
6. Backup: `ssh $A admin@$SERVER_IP 'sudo systemctl start omega-share-backup.service; systemctl show omega-share-backup.service -p Result'` is `success` and the newest file verifies.
7. Operator CLI: `ssh $A admin@$SERVER_IP 'sudo -u omega-share env DB_PATH=/var/lib/omega-share/omega.db /opt/omega-share/current/bin/omega-ops admin reports list'` answers; the monitor (`omega-share-monitor`) keeps counting reports.

### Hardening checklist on the aarch64 box (soak step)

None of these can be proved on a development machine; run all of them. Each failure has the same fix: drop only the named line from `deploy/omega-share.service` in a PR, say so in the issue, and re-provision. The unit file marks each with `BOX:`.

| Option | Check (as `admin@`) | Expect |
| --- | --- | --- |
| `MemoryDenyWriteExecute=yes` | the service is `active` and stays so under the 24 h load | no `status=SIGSEGV`/`SIGSYS`; `systemctl show omega-share -p MemoryDenyWriteExecute` is `yes` |
| `SystemCallFilter` (`@system-service`, minus `@privileged @resources @mount @obsolete @debug @raw-io @reboot @swap @cpu-emulation`) | `journalctl -u omega-share -p warning` after the soak, plus a snapshot, a restore, a room delete through the CLI and a graceful restart | no `status=31/SYS`; if one appears, `journalctl -k | grep -i audit` names the call |
| `SocketBindDeny=any` + `SocketBindAllow=tcp:8787`, `tcp:9464` (systemd 249+) | `ss -ltnp` shows the server on 127.0.0.1:8787 and 127.0.0.1:9464; `systemd-analyze security omega-share` lists no unknown-directive warning | it binds; metrics answer |
| `IPAddressDeny=any` + `IPAddressAllow=localhost` | Caddy still reaches `127.0.0.1:8787` (step 3.1); `systemctl show omega-share -p IPAddressDeny` | public requests succeed |
| `PrivateUsers=yes` | a room created in step 3.3 survives `systemctl restart omega-share`; `ls -ld /var/lib/omega-share` still `omega-share` 0700 | the DB opens read-write, the admin socket works (step 3.7) |
| `NoExecPaths=/var/lib/omega-share` | the DB and admin socket work; `systemctl show omega-share -p NoExecPaths` | no `Permission denied` for the DB |
| `LimitNOFILE=4096` | `grep 'Max open files' /proc/$(systemctl show -p MainPID --value omega-share)/limits` | 4096 (never lower: the connection caps are fixed numbers sized for it) |
| `LimitCORE=0`, `RUST_BACKTRACE=0`, no `NODE_ENV` | `systemctl show omega-share -p LimitCORE -p Environment` | `LimitCORE=0`; no `NODE_ENV` |
| Caddy `max_header_size`, `timeouts` | steps 3.4 and 3.5; `systemctl is-active caddy` | 431 over the limit; Caddy active |

Soak watch (24 h under load, then the 7 days): flat RSS, no restarts (`systemctl show omega-share -p NRestarts` is 0), `omega_ws_closes_total{code="4029"}` not climbing without a flooder, the journal free of errors.

## 4. Rollback (one command, 7 days)

```sh
env $D deploy/deploy.sh --server bun
```

from a checkout at or after this kit. It rebuilds the Bun release, stops `omega-share`, restarts `omega-share-bun` and checks `/healthz`. Faster, by hand as `deploy@`: flip `current` to the newest release without an `omega-server` file (`ls -1t /opt/omega-share/releases` shows it; deploys keep the newest Bun release past the usual 5), then `systemctl stop omega-share && systemctl restart omega-share-bun`. A release must not have a migration ahead of the Bun code: none may land in the window (the server refuses a DB with a newer `user_version`), or restore the pre-switch snapshot (backup.md § Restore, which picks the unit that serves the current release).

## 5. During the 7 days

- Daily: the three metrics above, `journalctl -u omega-share -p warning --since -1d`, the nightly snapshot's `Result` and `verify`, the monitor's ntfy.
- No migrations, no new Rust deploys that change the DB schema. Ordinary Rust deploys are fine (`--server rust`); each keeps the newest Bun release.
- After 7 days with no rollback and the board's sign-off: flip the `deploy.sh` default to `rust`, then S13 deletes the Bun server, `omega-share-bun.service` (and its provision/polkit lines), the Bun branch in `deploy/omega-ops` and `keepbun` in the deploy's prune step.
