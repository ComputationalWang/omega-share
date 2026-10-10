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
- `/.well-known/security.txt` (RFC 9116, OME-838) carries a fixed `Expires`. `apps/server/test/site.test.ts` fails 30 days before it. To renew, set `SECURITY_TXT_EXPIRES` in `apps/server/src/site-meta.ts` to a date 11 months out (under a year, as RFC 9116 asks) and deploy. Check: `curl -sS $PUBLIC_ORIGIN/.well-known/security.txt`.

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

## Monitoring (OME-765)

`deploy/monitor/monitor.sh` watches the site from **outside** the box. It runs on the operator machine from a user timer every 5 minutes, next to the backup pull, and needs no root. It sends a push to the operator's phone through [ntfy](https://ntfy.sh) only when something **changes**, so a quiet phone means nothing changed. Its state is in `~/.local/state/omega-share/monitor.state` (`$XDG_STATE_HOME`).

| Push | Means | Sent |
| --- | --- | --- |
| `omega-share is down` | `$PUBLIC_ORIGIN/healthz` failed (no 2xx within 10 s) twice in a row, so for 5 to 10 minutes. One blip never pushes. | once per outage |
| `omega-share recovered` | `/healthz` answers again after a `down` push. | once |
| `TLS certificate expires in N days` | The certificate has fewer than 14 days left. Caddy renews at about 30 days, so renewal has been failing for two weeks. | once, then again every 3 more days until it is renewed |
| `N new abuse reports` | The number of open reports went up since the last count. The monitor asks the box at most hourly, as `admin@`, with the operator CLI's `reports list`, and counts on the box: only the number leaves it. The count is net: a dismissal and a new report within the same hour cancel out, so read the queue daily anyway ([rooms.md](rooms.md#abuse-reports)). The first run after an install counts from 0, so it pushes every report already open. No notes, titles, ids or addresses ever go into a push. | when the count rose; flat or falling stays quiet |
| `[drill] …` | A test push. Ignore it. | by hand |

A push that can't be sent is retried at the next run, and that run's unit shows as failed.

**The topic is a secret.** Anyone who knows it can read the pushes and send fake ones. It lives only in `~/.config/omega-share/ntfy-topic` (mode `0600`). The script reads it from there and hands it to curl on stdin, so it never appears in argv, `ps`, the journal or the repo. Never paste it into an issue. To rotate it, write a new random topic into the file and subscribe the phone to the new one.

Install or update (user units only, from a checkout of `main`):

```sh
install -Dm755 deploy/monitor/monitor.sh ~/.local/libexec/omega-share/monitor.sh   # the unit runs this copy
install -Dm644 -t ~/.config/systemd/user deploy/monitor/omega-share-monitor.service deploy/monitor/omega-share-monitor.timer
systemctl --user daemon-reload
systemctl --user enable --now omega-share-monitor.timer
systemctl --user start omega-share-monitor.service      # run once now
journalctl --user -u omega-share-monitor -n 20           # "health check failed …", "pushed: …"
systemctl --user list-timers omega-share-monitor.timer
```

The service reads `PUBLIC_ORIGIN` and `SERVER_IP` from `~/Projects/omega-share/.env` and uses `~/.config/omega-share/admin-key` for the report count (`OMEGA_MONITOR_SSH_KEY` changes it). The box's host key must already be in `known_hosts`, because batch mode never asks. The unit runs its own copy of the script so that a branch checked out in the main repo can never break the monitor: copy it again after a change to `deploy/monitor/`.

The timer runs only while the operator machine is on. If the box goes down while the machine is off, the push comes at the first run after it wakes.

**Drill.** Point the health check at a bad URL with a separate state directory, so the real state is untouched, and run it twice. It pushes `[drill] omega-share is down` once:

```sh
d=$(mktemp -d); for i in 1 2; do XDG_STATE_HOME=$d OMEGA_MONITOR_URL=https://omega-share.invalid/healthz \
  OMEGA_MONITOR_CHECKS=health OMEGA_MONITOR_PREFIX='[drill]' ~/.local/libexec/omega-share/monitor.sh; done; rm -r "$d"
```

The first install and drill (2026-10-10) are recorded on [OME-765](/OME/issues/OME-765).

## Incident runbook

Set these once per shell:

```sh
set -a; . ~/Projects/omega-share/.env; set +a
A="-o IdentitiesOnly=yes -i ~/.config/omega-share/admin-key"
CLI="cd /opt/omega-share/current && sudo -u omega-share env DB_PATH=/var/lib/omega-share/omega.db /usr/local/bin/bun apps/server/src/cli.ts"
```

### `omega-share is down`

1. `curl -sS -m 10 -o /dev/null -w '%{http_code} %{time_total}s\n' $PUBLIC_ORIGIN/healthz`: is it still down from here? `000` with a DNS or connect error points at the box, its network or DNS. A `502` means Caddy is up and the server isn't.
2. `ssh $A admin@$SERVER_IP 'systemctl status omega-share caddy --no-pager -n 0; uptime; free -m; df -h / /var/lib/omega-share'`: which unit is down, and is the box out of memory or disk?
3. `ssh $A admin@$SERVER_IP 'journalctl -u omega-share -u caddy -n 60 --no-pager'`: the last lines before it went down. The server's errors are one JSON object each (see Checks).

Then: if the server crashed or hangs, `ssh $A admin@$SERVER_IP 'sudo systemctl restart omega-share'`. If it started right after a deploy, roll back (below). If ssh itself times out, the box or its network is down: check the Hetzner console. If the box answers but the name doesn't reach it, compare `getent ahostsv4 omega-share.duckdns.org | head -n 1` with `$SERVER_IP`.

### `TLS certificate expires in N days`

1. `h=${PUBLIC_ORIGIN#https://}; openssl s_client -connect $h:443 -servername $h </dev/null 2>/dev/null | openssl x509 -noout -enddate -issuer`: is the served certificate really the old one?
2. `ssh $A admin@$SERVER_IP "journalctl -u caddy --since -3d --no-pager | grep -iE 'obtain|renew|acme|challenge|error' | tail -n 30"`: why renewal fails.
3. `getent ahostsv4 omega-share.duckdns.org | head -n 1` (must start with `$SERVER_IP`) and `for p in 80 443; do timeout 4 bash -c "echo >/dev/tcp/$SERVER_IP/$p" && echo "$p open"; done`: the ACME challenges need the name to point at the box and both ports open.

Fix the cause, then `ssh $A admin@$SERVER_IP 'sudo systemctl restart caddy'` makes Caddy try again at once. The monitor goes quiet by itself once the new certificate is served.

### `N new abuse reports`

1. `ssh $A admin@$SERVER_IP "$CLI reports list"`: the open reports, most reported room first.
2. `ssh $A admin@$SERVER_IP "$CLI rooms list"`: the room's current title, visibility and members.
3. Decide: nothing to act on, `ssh $A admin@$SERVER_IP "$CLI reports dismiss --room <id>"`; abuse, take it down (next section).

The full procedure, and which links not to open, is in [rooms.md § Takedown](rooms.md#takedown-step-by-step).

### Take down a room fast

```sh
ssh $A admin@$SERVER_IP "$CLI rooms takedown <id>"     # expect "taken down <id>"
```

One command does it all: every socket in the room closes with 4006 and doesn't reconnect, share grants are revoked, the row is deleted, the id stays dead for good, and the room's open reports are marked actioned. Copy the id from the `/r/<id>` link or the `id` column, never from a title. Record the id, the UTC time and the reason on an issue. If the same kind of title keeps coming back, add it to `ROOM_TITLE_BLOCKLIST` in `/etc/omega-share/env` and restart ([rooms.md](rooms.md#takedown-step-by-step)).

### Roll back a deploy

`deploy.sh` puts the previous release back by itself when `/healthz` fails after its restart. To roll back a deploy that passed that check but misbehaves:

```sh
ssh -i "$DEPLOY_KEY_PATH" deploy@$SERVER_IP 'ls -1t /opt/omega-share/releases/; readlink -f /opt/omega-share/current'   # newest first; 5 kept
ssh -i "$DEPLOY_KEY_PATH" deploy@$SERVER_IP 'ln -sfn /opt/omega-share/releases/<older-sha> /opt/omega-share/current.new && mv -T /opt/omega-share/current.new /opt/omega-share/current && systemctl restart omega-share'
curl -sS -m 10 $PUBLIC_ORIGIN/healthz                                                                                   # ok
```

The restart is graceful: clients reconnect on their own. A release older than the 5 kept ones can be deployed again from a clean checkout of its commit with `deploy/deploy.sh`. A rollback across a DB migration doesn't work (the server refuses a DB whose `user_version` is newer than the code): restore the snapshot taken before the deploy instead ([backup.md § Restore](backup.md#restore)). Record what was rolled back and why on the deploy issue.
