# Backups and restore

Research: `docs/research/m4-hosting-and-sqlite.md` §2.5 · [OME-358](/OME/issues/OME-358) · deploy kit: `deploy/provision.sh` ([OME-356](/OME/issues/OME-356), wired in [OME-363](/OME/issues/OME-363))

The server keeps rooms, layouts and each room's last embed in one SQLite file (`DB_PATH`, WAL mode). The data is low-sensitivity: no IPs, no chat, no names. Backups still go only to places the operator alone can reach.

| Layer | Where | Kept | Tool |
| --- | --- | --- | --- |
| Nightly snapshot | the box, `/var/backups/omega-share/omega-<UTC date>.db` | newest 14 | `omega-share-backup.timer` → `apps/server/scripts/backup.ts snapshot` |
| Off-box copy | the operator's machine | newest 14 | `deploy/backup/pull.sh` (rsync over SSH) |
| Provider disk backup | the cloud provider | per provider | optional, see [Options](#options-not-set-up) |

Retention counts snapshots, not days. A box that was off for a month still has its last 14, and so does the off-box copy.

## Paths and names

These defaults match the deploy kit (`deploy/omega-share.service`, `deploy/provision.sh`; `apps/server/test/deploy-kit.test.ts` pins that they agree). Every script reads them from the environment, so a different layout only needs different values:

| What | Default | Override |
| --- | --- | --- |
| Service and its user | `omega-share` | `OMEGA_SERVICE`, `OMEGA_USER` (restore.sh); `User=` in the unit |
| Live database | `/var/lib/omega-share/omega.db` | `DB_PATH` (also read from `/etc/omega-share/env` by the unit) |
| Snapshots | `/var/backups/omega-share` (0700, service user) | `BACKUP_DIR` |
| App checkout | `/opt/omega-share/current` | `OMEGA_APP_DIR` |
| Bun | `/usr/local/bin/bun` | `OMEGA_BUN` |
| SSH user for pulls | `deploy` | the user in `OMEGA_BACKUP_SOURCE`, plus `sudoers.omega-backup` |

## Nightly snapshot (on the box)

`backup.ts snapshot` runs `VACUUM INTO` from a second connection. That is one read transaction, so the server keeps serving and writing while it runs, and the copy is one consistent point in time. The tests check this against a concurrent writer. Then the script:

1. writes into a hidden `.omega-<date>.db.tmp`, created `0600` before SQLite touches it;
2. checks the copy: `PRAGMA integrity_check`, foreign keys, a schema version this code knows, and every room row parsed by the server's own `RoomStore`;
3. switches the copy out of WAL so it is one self-contained file, then fsyncs it and renames it to `omega-<UTC date>.db`. A second run on the same day replaces that day's file;
4. prunes everything but the newest 14 `omega-<date>.db` files, plus any `.omega-<date>.db.tmp` untouched for an hour (left by a run killed mid-`VACUUM`; a failed run removes its own). Nothing else in the directory is touched.

The unit runs as the service user with `UMask=0077`, no network (`PrivateNetwork=yes`), a read-only system, and write access only to the snapshot directory and the DB's directory. A WAL reader writes the `-shm` file, so it needs the DB's directory too. The timer fires at 03:30 UTC (± 20 min) and catches up at boot after a night the box was off (`Persistent=true`).

Install (`deploy/provision.sh base` does this, plus the pull's sudoers rule; by hand as root):

```sh
install -d -o omega-share -g omega-share -m 0700 /var/backups/omega-share
install -m 0644 deploy/backup/omega-share-backup.service deploy/backup/omega-share-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now omega-share-backup.timer
systemctl start omega-share-backup.service          # take one now
journalctl -u omega-share-backup.service -n 5        # "snapshot /var/backups/omega-share/omega-….db"
systemctl list-timers omega-share-backup.timer       # next run
```

Check a snapshot by hand at any time. This works on a copy and never writes to the file:

```sh
runuser -u omega-share -- /usr/local/bin/bun /opt/omega-share/current/apps/server/scripts/backup.ts verify /var/backups/omega-share/omega-2026-10-08.db
# ok /var/backups/omega-share/omega-2026-10-08.db: 3 rooms
```

## Off-box copy (on the operator's machine)

`deploy/backup/pull.sh` runs where the operator works, not on the box. It needs `rsync` and `ssh`. It pulls only finished `omega-<date>.db` files (an in-progress `.tmp` never matches), writes them `0600` into a `0700` directory, and then keeps the newest 14. If the pull fails, it prunes nothing.

```sh
OMEGA_BACKUP_SOURCE=deploy@<box>:/var/backups/omega-share/ \
OMEGA_BACKUP_DEST=~/omega-share-backups \
OMEGA_BACKUP_SSH_KEY=~/.ssh/<deploy key> \
deploy/backup/pull.sh
```

- **The key comes from the environment.** `OMEGA_BACKUP_SSH_KEY` is a path to the deploy key. The script passes it to `ssh -i` with `BatchMode=yes` and `IdentitiesOnly=yes`, and never reads or prints the key. The box's host key must already be in `known_hosts`, because batch mode never asks.
- **Reading 0600 files.** The snapshots belong to the service user, so the remote side of rsync runs as that user. Install `deploy/backup/sudoers.omega-backup` as `/etc/sudoers.d/omega-backup` (mode `0440`, check it with `visudo -cf` first). It lets the `deploy` user run only the rsync *sender* (`--server --sender`) as `omega-share`. The sender only reads, but it reads any path `omega-share` can: the snapshots, and also the live DB and `/etc/omega-share/env`. That grants `deploy` nothing new, since it already ships the code that runs as `omega-share`. Pinning the path in the rule wouldn't narrow it: sudoers' `*` matches spaces, so the caller could append more source paths. Change `OMEGA_BACKUP_RSYNC_PATH` only if the box is laid out differently.
- **Schedule it** on the operator's machine. Run it daily, after the box's 03:30–03:50 UTC window. For example, with a user crontab entry: `30 5 * * * OMEGA_BACKUP_SOURCE=… OMEGA_BACKUP_DEST=… OMEGA_BACKUP_SSH_KEY=… /path/to/deploy/backup/pull.sh`. If the operator's machine is off, the next run catches up, because rsync copies every snapshot it doesn't have yet.

## Restore

Restore from a local snapshot with `deploy/backup/restore.sh` as root on the box. If the snapshot is an off-box copy, put it back first: `scp` it to the box, then run `install -o omega-share -g omega-share -m 0600 omega-<date>.db /var/backups/omega-share/`. The service user has to be able to read it.

```sh
deploy/backup/restore.sh /var/backups/omega-share/omega-2026-10-08.db
```

It runs these steps:

1. **Integrity check.** It runs `backup.ts verify` as the service user: `PRAGMA integrity_check`, foreign keys, the schema version, and every room and layout parsed. A corrupt, truncated, forged or empty snapshot is refused here, **before** anything stops, so a bad file costs no downtime.
2. **Stop the service.** `systemctl stop omega-share`.
3. **Copy to `DB_PATH`.** It runs `backup.ts restore` as the service user, so the owner is right, and the file gets mode `0600`. It checks the copy once more, then keeps the old database aside as `<DB_PATH>.pre-restore-<UTC stamp>` (a hard link, or a copy where links fail) and moves its `-wal` there, deletes any stale `-wal` and `-shm`, and renames the copy over `DB_PATH` in one atomic step. `DB_PATH` is never missing, even if the process dies midway, and a stale WAL is never replayed onto the restored file. If this step refuses, the service starts again on the old database, and the script exits 1. If `DB_PATH` is somehow gone by then, the service stays stopped instead of creating an empty database: put the newest `pre-restore` file back (see below) or rerun the script.
4. **Start and check.** `systemctl start omega-share`. Then it polls `http://127.0.0.1:8787/rooms` (`OMEGA_CHECK_URL`) and prints the room list. **Then check by hand:** open a room in the browser and confirm its furniture is where it was.

To undo a restore, stop the service, move `<DB_PATH>.pre-restore-<stamp>` (and its `-wal`, if any) back to `DB_PATH`, and start the service. Delete old `pre-restore` files once you're sure.

Without the wrapper (for example, a different service manager), do the same steps by hand: `backup.ts verify <file>`, stop, `DB_PATH=… backup.ts restore <file>` as the service user, start.

## Restore drill

`apps/server/test/backup.test.ts` runs the drill in CI: it seeds rooms and a moved layout, takes a snapshot through the CLI, wipes the DB, restores through `restore.sh`, starts the real server, and checks that `/rooms` and the room's layout come back. **Repeat it on the real box in the go-live issue:**

1. Note the rooms (`curl -s http://127.0.0.1:8787/rooms`) and move a piece of furniture in one room.
2. Take a snapshot now: `systemctl start omega-share-backup.service`. Pull it off-box with `pull.sh`.
3. Wipe: `systemctl stop omega-share`, then `mv /var/lib/omega-share/omega.db{,.drill}`, and remove `omega.db-wal` and `omega.db-shm`. Start the service: it seeds a fresh lobby. Confirm the moved furniture is gone.
4. Restore the **off-box** copy (put it back with `scp` + `install` as above): `deploy/backup/restore.sh /var/backups/omega-share/omega-<date>.db`.
5. Confirm that the room list matches step 1 and that the furniture is where you moved it. Record the times and output on the go-live issue, then delete `omega.db.drill`.

## Options not set up

- **Paid off-box storage is a board decision.** Examples: a Hetzner Storage Box, or an S3-compatible bucket at cents a month for files this small. Neither is set up. If the board approves one, push from the box with a second timer instead of pulling, using a write-only credential.
- **Provider disk backups** (about +20 % on some providers) are a second, whole-disk layer, and also a spend decision.
- **Point-in-time recovery** with Litestream (Apache-2.0, an external binary that replicates the WAL to object storage). It isn't needed while the data is a handful of rooms.
