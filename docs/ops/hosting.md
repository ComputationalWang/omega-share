# Hosting runbook (ADR 0020)

Production: **https://omega-share.duckdns.org**. One Hetzner CAX11 (aarch64, Ubuntu 26.04 LTS), with Caddy in front of `apps/server` on `127.0.0.1:8787`. The kit is in `deploy/`.

## Access

These board-local values are not in the repo. They live in the operator's `.env`, and the keys go into Paperclip secrets:

| Value | Where |
|---|---|
| `SERVER_IP` | operator `.env` |
| deploy key (`deploy@`) | `DEPLOY_KEY_PATH` in `.env`; Paperclip secret |
| admin key (`admin@`, sudo) | `~/.config/omega-share/admin-key` on the operator machine; Paperclip secret |
| DuckDNS token | operator `.env`; Paperclip secret |

Root login and passwords are off. Only `deploy` and `admin` can log in over SSH. `deploy` can restart `omega-share.service` but has no sudo. `admin` has sudo. Agents may run sudo on this box over ssh as `admin@` (board decision 2026-10-08, ADR 0020), once the board has approved the admin-key binding. The guard hook allows it for this host only. Run `provision.sh firewall-ok` in a new session within 3 minutes of a `base` run, or the firewall rolls back.

## Deploy

From a clean checkout of the commit to ship (a laptop or CI, never the box):

```sh
DEPLOY_HOST=deploy@$SERVER_IP DEPLOY_KEY=$DEPLOY_KEY_PATH deploy/deploy.sh --dry-run   # shows each step
DEPLOY_HOST=deploy@$SERVER_IP DEPLOY_KEY=$DEPLOY_KEY_PATH deploy/deploy.sh
```

The script refuses a dirty tree and a Bun that differs from `.bun-version` (checked both locally and on the box). It ends with a `/healthz` check on the box. Afterwards, check from outside: `curl -sI https://omega-share.duckdns.org/healthz`.

**Rollback:** list `/opt/omega-share/releases/` (the 5 newest are kept). Then, as `deploy`:

```sh
ln -sfn /opt/omega-share/releases/<older-sha> /opt/omega-share/current.new && mv -T /opt/omega-share/current.new /opt/omega-share/current
systemctl restart omega-share
```

A rollback across a DB migration doesn't work: the server refuses a DB whose `user_version` is newer than the code. In that case, restore the snapshot taken before the deploy (below).

## Provision (a new box, or after changing a root-owned file)

Root-owned files are the unit files, the Caddyfile, nftables, sshd, polkit, apt and Bun. They change only through `deploy/provision.sh`, run as root. The script is idempotent:

```sh
A="-o IdentitiesOnly=yes -i ~/.config/omega-share/admin-key"   # sshd allows 3 tries: offer only this key
rsync -a -e "ssh $A" deploy/ .bun-version admin@$SERVER_IP:omega-deploy/
ssh $A admin@$SERVER_IP "sudo DEPLOY_PUBKEY='…' ADMIN_PUBKEY='…' bash omega-deploy/provision.sh base"
ssh $A admin@$SERVER_IP "sudo bash omega-deploy/provision.sh firewall-ok"   # from a NEW session, within 3 min
ssh $A admin@$SERVER_IP "sudo bash omega-deploy/provision.sh ssh"           # once deploy@ and admin@ both log in
```

To change only the Caddyfile or the journald retention on a running box, rsync as above and run `provision.sh logs`. It touches no users, packages or firewall.

On a brand-new box, the first run is `root@` with the board's key. The `ssh` phase then turns root login off.

## Backups and restore

The runbook is [`docs/ops/backup.md`](backup.md). `provision.sh base` installs all of it (OME-363):

- **On the box:** `omega-share-backup.timer` (03:30 UTC ± 20 min, `Persistent=true`) runs `apps/server/scripts/backup.ts snapshot` from the current release as `omega-share`. It writes a checked `/var/backups/omega-share/omega-YYYY-MM-DD.db` (0600, in a 0700 dir) and keeps the newest 14. To check it: `systemctl list-timers omega-share-backup.timer`.
- **Off the box:** `deploy/backup/pull.sh` rsyncs the snapshots as `deploy` to the operator machine and keeps the newest 14. `/etc/sudoers.d/omega-backup` lets `deploy` run the rsync sender as `omega-share`. That is no more than `deploy` already has, since it ships the code `omega-share` runs. `pull.sh` needs bash 4 or newer and GNU `find`. A daily user timer runs it there:

  ```ini
  # ~/.config/systemd/user/omega-share-pull-backups.service
  [Service]
  Type=oneshot
  EnvironmentFile=%h/Projects/omega-share/.env
  ExecStart=/bin/sh -c 'OMEGA_BACKUP_SOURCE=deploy@$SERVER_IP:/var/backups/omega-share/ OMEGA_BACKUP_DEST=%h/.local/share/omega-share/backups OMEGA_BACKUP_SSH_KEY=$DEPLOY_KEY_PATH exec %h/Projects/omega-share/deploy/backup/pull.sh'
  # ~/.config/systemd/user/omega-share-pull-backups.timer
  [Timer]
  OnCalendar=*-*-* 05:30:00 UTC
  Persistent=true
  [Install]
  WantedBy=timers.target
  ```

  Enable it with `systemctl --user enable --now omega-share-pull-backups.timer`. `Persistent=true` catches up after the machine was off.
- **Restore:** as `admin`, from the box's copy of the kit (`~/omega-deploy/`, see Provision), run `bash omega-deploy/backup/restore.sh /var/backups/omega-share/omega-YYYY-MM-DD.db`. It verifies the snapshot before it stops anything. See [backup.md § Restore](backup.md#restore).

After a restore, rooms, layouts and each room's last embed come back, with playback paused at 0. Presence, chat and share tokens are memory-only by design.

**Drill record, 2026-10-08 (go-live, OME-356, with the earlier sqlite3 `backup.sh` that OME-363 replaced):** the drill started with `lobby` holding the Vimeo embed from the headed smoke. The snapshot was taken with the timer's own unit. The live DB was then moved away to simulate a loss, and the snapshot was restored. After the restart, the same `lobby` row came back (layout of 597 bytes, the same Vimeo embed), with `user_version` 1, `integrity_check` ok and `/rooms` listing `lobby`. The off-box pull of that snapshot also passed `integrity_check`.

## Checks

- Open ports from outside: only 22, 80 and 443 (`for p in 22 80 443 2019 8787; do timeout 4 bash -c "echo >/dev/tcp/$SERVER_IP/$p" && echo "$p open"; done`).
- The Host allowlist on the box: `curl -H 'Host: evil.example' 127.0.0.1:8787/healthz` returns 421.
- Headed smoke from outside, on a virtual display: `OMEGA_REAL_TUNNEL_ORIGIN=https://omega-share.duckdns.org bun e2e/support/headed.ts bunx playwright test --project=e2e-real e2e/real/real-tunnel.real.ts --grep "tunnel-[124]"`. Tunnel-3 checks the Host rule on *this* machine's port 8787, so against the box, use the curl above instead.
- Logs (as `admin`): `journalctl -u omega-share`, `journalctl -u caddy`. The server's error lines are one JSON object each, with a fixed `event` name and no room id, title, nickname or address (ADR 0032 §4). To list only those, run `journalctl -u omega-share -o cat | grep '^{"level":"error"'`. Caddy keeps no access log and has no admin API (`admin off`), so Caddyfile changes take `systemctl restart caddy`. Caddy's default logger deletes request IPs, ports and headers, so an upstream 502 is logged with only the method, host and URI, and no site visitor's IP reaches the journal (ADR 0020 §3, OME-386). The journal is persistent and kept for 14 days (`deploy/journald/omega-share.conf`). sshd's entries name SSH peers. To check, run `journalctl -u caddy -o cat | grep -cE 'remote_ip|client_ip|"headers"'` with root. It should print 0.
- Off-box pull fails loudly if the newest snapshot is older than 36 h: that is the backup alarm.

## Metrics, logs and restarts (OME-504, ADR 0032)

- **Metrics** are served on `127.0.0.1:9464` only (`METRICS_PORT` in `deploy/omega-share.service`). Caddy doesn't proxy them and the firewall doesn't open the port, so read them over ssh:

  ```sh
  ssh -i "$DEPLOY_KEY_PATH" deploy@$SERVER_IP 'curl -s 127.0.0.1:9464/metrics'
  # one series:
  ssh -i "$DEPLOY_KEY_PATH" deploy@$SERVER_IP 'curl -s 127.0.0.1:9464/metrics | grep ^omega_sockets'
  # or forward the port and point a local Prometheus or browser at localhost:9464:
  ssh -i "$DEPLOY_KEY_PATH" -N -L 9464:127.0.0.1:9464 deploy@$SERVER_IP
  ```

  Series: `omega_rooms`, `omega_sockets`, `omega_members`, `omega_relay_latency_seconds` (histogram of the server's own relay time per frame; `_sum / _count` is the mean), `omega_ws_closes_total{code}` (4029 = flooders cut off, 4004 = rooms closed, 1012 = restarts, 4400 / 4001 / 4002), `process_resident_memory_bytes` and `process_uptime_seconds`. Nothing in it names an address, nickname, room or title. A forwarded port needs `Host: localhost:9464` or `127.0.0.1:9464`; anything else gets 421.
- **Logs** go to journald (see Checks above). Rotation is in `deploy/journald/omega-share.conf`: 14 days, at most 256 MB in total, files rotated at 32 MB or daily. Re-ship it with `provision.sh logs`. To see the usage, run `journalctl --disk-usage`.
- **Restart** (`systemctl restart omega-share`, which is what `deploy.sh` does) is graceful. On SIGTERM the server stops accepting, closes every socket with 1012, saves who sat where (as name hashes, for 30 s), checkpoints and closes the database and exits 0 within `TimeoutStopSec=10s`. Clients reconnect on their own and come back in their seats with the same embed. Playback restarts paused at 0. To check a restart, run `journalctl -u omega-share -n 20`. It should show no `"level":"error"` line between `Stopping` and `Started`, and `omega_ws_closes_total{code="1012"}` resets to 0 with the new process.
