# Rooms: listing, reports, takedowns and pins

Decision: ADR 0028 (room ownership), ADR 0033 (abuse reports and takedowns) · threat model `docs/research/m4-rooms-threat-model.md` §1.3, §4.2 E · [OME-407](/OME/issues/OME-407), [OME-595](/OME/issues/OME-595)

Anyone can create a room, and owners can rename and delete their own. The operator steps in only for **abuse**: people report a room from the site ("Report this room", `POST /rooms/:id/report`), the reports wait in a queue only the operator can read, and the operator dismisses them or **takes the room down**. There are no accounts, no bans and no moderators. A takedown ends one room for good. It does not block the person who made it.

The tool is `apps/server/src/cli.ts`. It talks to the **running** server over a Unix socket, so a delete or takedown ends the live room exactly as an owner delete or GC would. On `rooms delete`, every member's socket closes with `ROOM_CLOSED` (4004, and clients don't reconnect), their share grants are revoked, the row is deleted, and the room leaves `GET /rooms`. A deleted id is never reissued (128-bit random ids). `rooms takedown` does the same with close code `TAKEN_DOWN` (4006) and also keeps the id dead (see [Takedown](#takedown-step-by-step)). Nightly backups still hold the row: the last 14 nightly backups, locally and off-box ([backup.md](backup.md)).

## The socket

| What | Default | Override |
| --- | --- | --- |
| Socket | `admin.sock` beside `DB_PATH`, so on the box `/var/lib/omega-share/admin.sock` | `ADMIN_SOCKET=<path>`, or `ADMIN_SOCKET=off` for no socket |
| Access | mode `0600`, owned by `omega-share`, in the `0700` state directory | none: file permissions are the only auth, and the socket never listens on TCP |

The server creates the socket at startup and replaces a stale one left by a crash. If something other than a socket sits at that path, the server logs `ADMIN_SOCKET …: the operator CLI is unavailable` and keeps serving the site. Remove that file and restart the service to get the CLI back.

The CLI finds the socket from the same variables (`ADMIN_SOCKET`, else `DB_PATH`). The unit sets `DB_PATH`, but your shell does not, so pass it every time (see below).

## Running it on the box

From the operator machine, as `admin@` (see [hosting.md](hosting.md) for the key and `SERVER_IP`):

```sh
A="-o IdentitiesOnly=yes -i ~/.config/omega-share/admin-key"
ROOMS="cd /opt/omega-share/current && sudo -u omega-share env DB_PATH=/var/lib/omega-share/omega.db /usr/local/bin/bun apps/server/src/cli.ts rooms"
ssh $A admin@$SERVER_IP "$ROOMS list"
```

- `sudo -u omega-share`: only the service user can open the socket. Running it as `admin` without sudo fails with `no server on …` (permission denied).
- `cd /opt/omega-share/current`: the service user can't read `admin`'s home, and Bun reads config from the working directory.
- If `/etc/omega-share/env` moves the database, pass that `DB_PATH` instead (or `ADMIN_SOCKET=<path>`).

### Commands

| Command | Does | Prints |
| --- | --- | --- |
| `rooms list` | Every live room, private ones included, oldest first | A tab-separated table: `id`, `title`, `visibility`, `created`, `last active`, `pinned`, `members` |
| `rooms delete <id>` | Ends the room (see above) | `deleted <id>` |
| `rooms takedown <id>` | Ends the room for good after a report (ADR 0033 §5, below) | `taken down <id>`, plus `(it was not live)` if the room had already gone |
| `reports list` | Open reports, grouped by room, most reported first | One line per room, then one indented line per report, newest first (below) |
| `reports dismiss <reportId>` | Closes one report: no action needed | `dismissed 1` |
| `reports dismiss --room <id>` | Closes all of a room's open reports | `dismissed <n>` |
| `rooms pin <id>` | GC never collects the room | `pinned <id>` |
| `rooms unpin <id>` | GC may collect it again (1 h after creation if nobody ever joined, 14 days after it last emptied). Refused for a seeded room | `unpinned <id>` |

Exit codes: `0` done; `1` no such room or open report, no server on the socket (or no answer within 10 s), a refused unpin, or a server error; `2` bad usage or a malformed id (room ids are `[a-z0-9-]`, at most 32 characters; report ids are 22 characters of `[A-Za-z0-9_-]`). Bad usage never reaches the server.

`list` never prints owner tokens, invite keys or their hashes, and the server's answer doesn't contain them. Times are UTC ISO 8601. `last active` is when the room last became occupied or empty (`never` if nobody ever joined). An untitled room shows `-`. Control and format characters in a title (escape sequences, tabs, bidi overrides) are printed as `\uXXXX`, so a hostile title can't rewrite your terminal. Copy ids from the `id` column, never from a title.

## Abuse reports

A report is `{ reason, note? }` sent from the site. The six reasons are `sexual`, `violence`, `hate`, `spam`, `danger` (someone may be in danger) and `other`. The note is optional free text, at most 300 characters.

**What is kept** (table `reports`, ADR 0033 §3): a random report id, the room id, the reason, the note **after redaction** (emails become `<email>`, IP addresses `<ip>`, phone-like numbers `<phone>`), the room's title and the URL of what was playing *at report time*, the time, and the state (`open`, `dismissed`, `actioned`). **Nothing about the reporter** is kept: no address, hashed address, user agent, nickname or token. Reports are never logged. `/metrics` (localhost only) counts them by outcome and reason, plus the open-report gauge `omega_reports_open` and `omega_takedowns_total`, with no room ids or notes.

**How long:** every report row is deleted 30 days after it was made, whatever its state, by the hourly GC sweep. Backups keep copies until they rotate out: the last 14 nightly backups, locally and off-box ([backup.md](backup.md)). Backups prune by count, not age, so after an outage of the nightly job a report can stay in the oldest kept backups for more than 44 days. To be sure a report is gone, wait until 14 newer nightly backups exist.

**Limits** (memory only, reset by a restart): per reporter address, 3 reports at once, then one every 10 minutes; per room, 20 at once, then one a minute; at most 1000 open reports in total, past which new reports get `unavailable`. The same address reporting the same room twice within 30 days gets "already reported", and nothing new is stored. Dismissed and actioned rows are capped at 5000 rows in total: past that, the oldest closed rows are deleted first.

**Check the queue daily** while the beta runs, and whenever `omega_reports_open` rises:

```sh
REPORTS="cd /opt/omega-share/current && sudo -u omega-share env DB_PATH=/var/lib/omega-share/omega.db /usr/local/bin/bun apps/server/src/cli.ts reports"
ssh $A admin@$SERVER_IP "$REPORTS list"
```

```
<room id>	<title now | (taken down) | (gone)>	<visibility>	members <n>	<n> open	hate 1, sexual 2
  <UTC time>	<reason>	<report id>	note: <note | ->	title then: <title | ->	playing: <url | ->
```

`title then` and `playing` are what the room showed when the report was made; the owner may have renamed it or changed the video since. Notes and titles are user text, so control and format characters print as `\uXXXX`. Copy ids from the id columns, never from a note or title. **Don't open `playing` URLs in your browser while logged in to anything.** Open them in a private window and only if you need to see the content.

## Takedown, step by step

1. **Read the queue:** `"$REPORTS list"`. Look at the reasons, notes, title and what was playing. A report outside the queue (an email to the CEO, an issue) works the same way: it names a room by its `/r/<id>` link or its lobby title. Don't put an invite link's `#k=…` part in an issue: the id is enough, and the key is a secret.
2. **Check the room:** `"$ROOMS list"` shows its current title, visibility and member count. Private rooms are listed too.
3. **Decide:**
   - Nothing to act on: `"$REPORTS dismiss <reportId>"`, or `"$REPORTS dismiss --room <id>"` for all of a room's reports. The room stays, and people can report it again.
   - Abuse: **`"$ROOMS takedown <id>"`**. Expect `taken down <id>`.
4. **What the takedown does**, in one step: it writes the id to the `takedowns` table (kept indefinitely: an id isn't personal data), closes every socket in the room with `TAKEN_DOWN` (4006; the site shows "This room was closed by the omega-share team after a report." and doesn't reconnect), revokes every share grant so pending shares and queue adds get `room_not_found`, deletes the room's row, queue and seat holds, and marks its open reports `actioned`.
5. **Afterwards the id stays dead:** `POST /rooms` never mints it, a seeded room with that id isn't seeded again at startup, a join is closed with 4006 before anything from the room is sent, `share`, `queue` and `report` answer `room_not_found`, and it isn't in `GET /rooms`. Run `"$ROOMS list"` again to confirm it's gone.
6. **Record it** on the issue: the id, the UTC time and the reason. Don't record the title or note if they were the abuse. Nothing else about the room or the reporters exists to record.
7. **Repeat offenders:** with no accounts, the owner can create a new room and share the same thing again. Take that room down too. If the same kind of *title* keeps coming back, add the term to `ROOM_TITLE_BLOCKLIST` in `/etc/omega-share/env` (comma-separated; case and lookalikes are folded) and restart the service. From then on, matching titles can't be created, and existing matching rooms drop out of `GET /rooms`. Those rooms still exist, so take them down as well. Anything beyond that (address bans) needs its own ADR first (ADR 0028 §7).

If `takedown` prints an error, nothing was changed when the tombstone couldn't be written: fix the cause (`journalctl -u omega-share`) and run it again. If the room's row couldn't be deleted, the server logs `store.delete_room` and the next restart deletes it. Running `takedown` again is always safe.

**Undoing a takedown** (a mistake): there's no command for it. Stop the service, delete the `takedowns` row by hand, then start it again. The server loads the tombstones only at startup, and the database must not be edited while it runs:

```sh
ssh $A admin@$SERVER_IP 'sudo systemctl stop omega-share'
ssh $A admin@$SERVER_IP "cd /opt/omega-share/current && sudo -u omega-share /usr/local/bin/bun -e 'const { Database } = require(\"bun:sqlite\"); const db = new Database(\"/var/lib/omega-share/omega.db\"); console.log(db.run(\"DELETE FROM takedowns WHERE room_id = ?\", [process.argv.at(-1) ?? \"\"]).changes)' <id>"
ssh $A admin@$SERVER_IP 'sudo systemctl start omega-share'
```

It prints `1` if the row was deleted, `0` if that id wasn't taken down. The id can then be used again, but the room comes back only if it's a seeded room (empty, ownerless). A created room's row was deleted, so the owner has to create a new one.

`rooms delete <id>` is still there for rooms that aren't abuse (a seeded room you no longer want, a leftover row). It leaves the id usable.

## Pinning

Pin a room the operator wants to keep however long it sits empty (an event room, for example). Pinning doesn't change ownership: a created room keeps its owner, who can still rename or delete it. Pinned rooms come first in `GET /rooms`.

Seeded rooms (`lobby`) are pinned and ownerless, and `unpin` refuses them (exit 1): with no owner to delete it, an unpinned seed would be collected by GC and come back, empty, only at the next restart. `delete lobby` does work. The lobby is gone until the next restart re-seeds it, empty.

## Without a running server

The CLI needs the running server. If the service is down, start it first (`systemctl start omega-share`). Nobody can join a room while the service is down, so nothing is being served in the meantime. Never edit the database by hand while the service runs: the server keeps rooms in memory and would serve the old state until the next restart.
