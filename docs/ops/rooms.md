# Rooms: listing, takedowns and pins

Decision: ADR 0028 (room ownership) · threat model `docs/research/m4-rooms-threat-model.md` §1.3, §4.2 E · [OME-407](/OME/issues/OME-407)

Anyone can create a room, and owners can rename and delete their own. The operator steps in only for **takedowns**: the CEO triages a report, and the Lead deletes the room on the box. There are no accounts, no bans and no moderators. A takedown removes one room. It does not block the person who made it.

The tool is `apps/server/src/cli.ts`. It talks to the **running** server over a Unix socket, so a delete ends the live room exactly as an owner delete or GC would. Every member's socket closes with `ROOM_CLOSED` (4004, and clients don't reconnect), their share grants are revoked, the row is deleted, and the room leaves `GET /rooms`. The id is never reissued (128-bit random ids, no tombstone). Nightly backups still hold the row for up to 14 days ([backup.md](backup.md)).

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
| `rooms pin <id>` | GC never collects the room | `pinned <id>` |
| `rooms unpin <id>` | GC may collect it again (1 h after creation if nobody ever joined, 14 days after it last emptied) | `unpinned <id>` |

Exit codes: `0` done; `1` no such room, no server on the socket, or a server error; `2` bad usage or a malformed id (ids are `[a-z0-9-]`, at most 32 characters). Bad usage never reaches the server.

`list` never prints owner tokens, invite keys or their hashes, and the server's answer doesn't contain them. Times are UTC ISO 8601. `last active` is when the room last became occupied or empty (`never` if nobody ever joined). An untitled room shows `-`. Control and format characters in a title (escape sequences, tabs, bidi overrides) are printed as `\uXXXX`, so a hostile title can't rewrite your terminal. Copy ids from the `id` column, never from a title.

## Takedown, step by step

1. **The report** names a room: a `/r/<id>` link, or a title seen in the lobby list. The CEO triages it and files an issue for the Lead with the id and the reason. Don't put an invite link's `#k=…` part in the issue: the id is enough, and the key is a secret.
2. **Find it:** `"$ROOMS list"`, then check the id, title and member count. For a title-only report, match the title in the list. Private rooms are listed too.
3. **Delete it:** `"$ROOMS delete <id>"`. Expect `deleted <id>`. Run `list` again to confirm the room is gone.
4. **Record it** on the issue: the id, the UTC time, and the reason. Don't record the title if the title itself was the abuse. Nothing else about the room is kept.
5. **Repeated titles:** if the same kind of title keeps coming back, add the term to `ROOM_TITLE_BLOCKLIST` in `/etc/omega-share/env` (comma-separated; case and lookalikes are folded) and restart the service. From then on, matching titles can't be created, and existing matching rooms drop out of `GET /rooms`. Those rooms still exist, so delete them as well.

If `delete` prints an error after the room was already removed from memory (a failed store write is logged in `journalctl -u omega-share`), run the same `delete` again. It deletes a row left behind even when the room is no longer live, and prints `deleted <id>`.

## Pinning

Pin a room the operator wants to keep however long it sits empty (an event room, for example). Pinning doesn't change ownership: a created room keeps its owner, who can still rename or delete it. Pinned rooms come first in `GET /rooms`.

Seeded rooms (`lobby`) are pinned and ownerless. Don't unpin them. An unpinned room nobody has joined for an hour is collected at the next hourly sweep, and the lobby only comes back, empty, at the next restart. Deleting `lobby` behaves the same way: it is gone until the next restart re-seeds it.

## Without a running server

The CLI needs the running server. If the service is down, start it first (`systemctl start omega-share`). Nobody can join a room while the service is down, so nothing is being served in the meantime. Never edit the database by hand while the service runs: the server keeps rooms in memory and would serve the old state until the next restart.
