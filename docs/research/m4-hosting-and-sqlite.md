# M4 research: hosting, SQLite persistence, room-layout contract

**Status:** research, 2026-10-01 · [OME-260](/OME/issues/OME-260) · Lead Engineer
**Gate:** no M4 engineering starts until the board approves M3 (approval f4c028a5). **Spending money is a board decision**: §5 is the table for that decision.

Today everything lives in server memory (`apps/server/src/room.ts`). The room list is fixed at startup (`server.ts:45`, default `["lobby"]`), and the room layout (a 10×10 floor, 8 armchair seats, a TV) is hard-coded in `apps/web/src/layout.ts`. The public deploy is an operator-run tunnel in front of one server process that serves the site and the API/WS on one origin (ADR 0015).

## TL;DR

- **Host:** one small **Hetzner Cloud VPS** (EU), running **Caddy** (TLS, Apache-2.0) on the same box in front of the existing single-origin `apps/server` process under systemd. It costs about **€7/mo all-in** (≈ $8). The Caddy peer is loopback, so `TRUST_PROXY=loopback`, the Host/Origin allowlists and every M3 limit work **unchanged**. Runner-up: Fly.io (≈ $4–6/mo). It is cheaper, but it needs a new client-IP trust mode and puts the SQLite volume on one host.
- **SQLite:** `bun:sqlite`, which is built in and adds **no new dependency**. Use WAL mode, forward-only numbered migrations tracked in `PRAGMA user_version`, and a nightly `VACUUM INTO` snapshot copied off the box. **Persist** rooms, room layout (furniture) and each room's last embed. **Keep in memory** presence, seats, playback, share tokens, rate limiters and chat.
- **Contract:** one small contract issue. It adds `FurnitureSchema` and `RoomLayoutSchema`, plus `snapshot.room.layout`, which is **optional** so old clients still parse. `FLOOR_CELLS` moves to shared constants. Armchairs are the seats, and a layout has exactly `SEAT_COUNT` of them, so `seats[]` keeps its length and the seat contract doesn't change. No client → server message is added in M4. Editing a layout from the client (an owner token and a `layout-set` message) is a separate, later contract issue.
- **Safety/perf deltas:** add HSTS, enforce Trusted Types (it is report-only today), keep the server bound to `127.0.0.1`, don't put Cloudflare's proxy in front, keep access-log retention short, and Valibot-parse every row read from the database. The perf budgets don't change. Add one informational measurement against the hosted origin, which doesn't block merges.

## 1. Hosting options

Our scale: one process, under 50 concurrent sockets (global cap 200, `server.ts:43`), a few GB of egress a month (the video comes from the providers, not from us), and a SQLite file of a few MB. Prices were checked on 2026-10-01 against provider pages. Entries marked *(secondary)* come from third-party trackers and must be re-checked on the order page.

| | **Hetzner Cloud VPS** | **Fly.io** | **Railway** | DigitalOcean droplet | Render |
|---|---|---|---|---|---|
| Plan | CX23 (2 vCPU / 4 GB, x86) €5.49, or CAX11 (ARM) €5.99. If both are sold out: CPX12 ≈ €11.99 *(secondary)* | shared-cpu-1x 512 MB ≈ $3.34 (iad) | Hobby $5, includes $5 of usage | Basic 512 MiB $4 | Starter 512 MB $7 *(secondary)* |
| Storage for SQLite | Local NVMe (40 GB), with nothing extra to set up | Volume $0.15/GB, **pinned to one host**; snapshots $0.08/GB (10 GB free) | Volume $0.15/GB | Local SSD (10 GiB) | Disk $0.25/GB *(secondary)*, paid tiers only |
| Backups | Daily, 7 slots, +20 % ≈ €1.10 *(secondary)* | Volume snapshots (daily) | Manual | +30 % daily, +20 % weekly | Daily disk snapshots, 7 days |
| WebSockets / idle | No middlebox: our own `idleTimeout: 60` + `sendPings` (ADR 0018 §4) | Proxied, no TCP idle timeout since 2023; GoAway on machine stop | Proxied; WS exempt from request limits, "no duration guaranteed" | No middlebox | No duration limit; pings recommended |
| TLS | Caddy on the box (automatic ACME) | Managed, first 10 certs free | Managed | Caddy on the box | Managed |
| Client IP | **Loopback peer + XFF from Caddy: today's code path** | Peer is fly-proxy on a private address; `Fly-Client-IP` header. **Needs a new trust mode** | Proxy header (`X-Forwarded-For`, X-Real-IP); peer not loopback. **Needs a new trust mode** | Same as Hetzner | Proxy header. Needs a new trust mode |
| Regions | Cheap plans are **EU only** (Nuremberg, Falkenstein, Helsinki). US (Ashburn, Hillsboro) needs CPX, from $20.49 | Global; iad price ×1–1.6 elsewhere | US West, US East, EU West (Amsterdam), Singapore | Global | US/EU |
| Egress | 20 TB included (EU) | $0.02/GB (NA/EU) | $0.05/GB | 500 GiB included | 5 GB included *(secondary)* |
| Lock-in | **None**: a plain Linux VM, systemd unit plus Caddyfile in the repo | Low to moderate: a Docker image, but `fly.toml`, volumes and the proxy are Fly-specific | Low: a Docker image, but the volume and proxy are Railway-specific | None | Low |
| AGPL fit | Fine: we run our own code; source offered via the repo link (AGPL §13) | Fine | Fine | Fine | Fine |
| Est. monthly | **≈ €7.10** (CX23 €5.49 + IPv4 ≈ €0.50 + backups ≈ €1.10) | ≈ $4–6 (+$2 for a dedicated IPv4) | ≈ $5 (fits the included credit) | ≈ $5.20 with daily backups | ≈ $7.25 |

AGPL: none of the providers restricts AGPL code. Our obligation (§13) is to offer the source to network users. A "Source" link in the site footer to the public GitHub repo does that. That is a web issue in the M4 list. No provider ToS was reviewed for anything beyond that.

### Recommendation: Hetzner Cloud CX23 (or CAX11) in Falkenstein/Nuremberg, Caddy + systemd

1. **It keeps the M2/M3 safety model as tested.** ADR 0015 §5 and ADR 0018 §3 trust `X-Forwarded-For` only from a **loopback** peer, and only its rightmost entry. Caddy on the same box is exactly that topology, the same one the tunnel and the reverse-proxy e2e fixture (OME-132) prove today. Every PaaS puts its proxy on a non-loopback address, so we would have to add and test a new trust mode, such as "trust `Fly-Client-IP` from `fdaa::/16`". That is new boundary code on the most safety-critical path, written only to save about €3 a month.
2. **SQLite wants a local disk and a single writer.** A VPS gives exactly that. The Fly and Railway volumes are fine, but they are pinned to one machine, and a platform-initiated machine move or restart is out of our hands.
3. **No lock-in.** The deploy is a systemd unit, a Caddyfile and a script, all in the repo. Moving to any other VM is an `rsync` away.
4. **Cost is flat and predictable.** It has no usage meter, so a flood can't run up a bill. The 20 TB of egress is far more than we need.
5. **Latency:** one EU region. RTT is about 90 ms to US East and about 150 ms to US West. Both are far inside the 500 ms sync-spread budget, because sync is driven by state updates, not by RTT. If the board's audience is mostly American, the same plan works on a $4–6 DigitalOcean droplet in NYC or SFO, though that box has only 512 MiB. We would then build in CI or locally and ship artifacts, never building on the box.

**Caveat:** Hetzner's page showed CX23/CAX11 as "currently unavailable" on 2026-10-01. If they are still sold out when we order, there are two equal fallbacks: CPX12 at about €12, or a DigitalOcean $4 droplet with daily backups at $5.20. Both use the same topology.

**What the board must approve:** the monthly spend (§5), a domain name (≈ $10–15/yr), and who holds the provider account. Credentials (the provider API token, the SSH deploy key and the DNS token) become Paperclip secrets. They never go in the repo, the same rule as for the ngrok token in ADR 0015 §2.

**Topology (to be recorded as ADR 0020 once approved; it supersedes the tunnel part of ADR 0015 §1):**

```
client ──TLS──▶ Caddy :443 (same VPS) ──http──▶ 127.0.0.1:8787 apps/server (Bun, systemd)
                 automatic ACME, HTTP/2,          serves apps/web/dist + API + /rooms/:id/ws
                 encode zstd gzip                 PUBLIC_ORIGIN=https://<domain>, TRUST_PROXY=loopback
                                                  DB_PATH=/var/lib/omega-share/omega.db
```

- The firewall allows only 22 (key-only, from the operator's addresses if practical), 80 (ACME, then redirect) and 443.
- Deploy flow: CI or the operator builds the site and runs `bun install --frozen-lockfile`. It rsyncs the release to `/opt/omega-share/releases/<sha>`, flips a `current` symlink and runs `systemctl restart omega-share`. A restart drops every socket for a second or two. Clients already reconnect with backoff, and in-memory playback is lost (see §2.4). No zero-downtime machinery in M4.
- Pin Bun. The repo pins nothing today, so add a `packageManager` field or a `.bun-version` file, and have the deploy script check it.

## 2. SQLite

### 2.1 Driver

| Option | Verdict |
|---|---|
| **`bun:sqlite`** | **Use it.** Built into Bun: zero dependencies, nothing added to the bundle (server only anyway), synchronous API, prepared statements, transactions, `.safeIntegers()`. Fastest option on Bun. |
| `better-sqlite3` | Node native addon; redundant on Bun and adds a native build step. |
| libSQL / Turso | Remote or embedded-replica database: a vendor, a network hop and a dependency to solve a problem we don't have (one writer, one box). |
| Drizzle or another ORM / query builder | Not now. Under 10 queries, typed by hand with Valibot at the read boundary. Revisit if the schema grows past a handful of tables. |
| Postgres | Overkill for one process, and a second service to run and back up. |

Settings at open: `journal_mode=WAL`, `synchronous=NORMAL`, `foreign_keys=ON`, `busy_timeout=2000`. Use one `Database` per process with prepared statements cached at module load.

### 2.2 What M4 persists

| Data | Persist? | Why |
|---|---|---|
| **Rooms** (`id`, `title`, `created_at`) | **Yes** | Rooms survive a restart. Seeds `lobby` on first boot. |
| **Room layout** (furniture placements) | **Yes** | The point of "customizable rooms begin". |
| **Last embed per room** (canonical URL plus provider) | **Yes, recommended** | Otherwise every deploy blanks every TV. Written only on `embed-changed`, which is already capped at 2 shares / 10 s per room. After a restart, playback comes back **paused at 0**. |
| Display names | **No** | There are no accounts. A nickname is per-session, unique per room only while the member is present (ADR 0016 §2), and the client already remembers its own. Persisting it would create identities without auth. |
| Chat | **No** | Privacy, and moderation load we don't have. Chat stays ephemeral. |
| Presence, seats, `catching`, playback state, `rev` | **No (memory)** | Hot, high-churn state. Writing it would put disk I/O on the relay path. |
| Share tokens, rate-limit buckets, client keys / IPs | **No (memory)** | Short-lived secrets and personal data (IP addresses). Never on disk. |

Proposed schema (migration `0001`):

```sql
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
  title       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,          -- unix ms
  layout      TEXT NOT NULL,             -- JSON, RoomLayoutSchema (§3); Valibot-parsed on read
  embed       TEXT                       -- JSON, EmbedSchema, or NULL
) STRICT;
```

Store the layout as **one JSON column**, not a `furniture` table. It is always read and written whole, and it is capped at `MAX_FURNITURE` items (about 2 KB). The contract schema validates it on read and on write, so there's no ORM-shaped mismatch, and a corrupt or hand-edited row fails the parse loudly instead of reaching clients. A per-item table only pays off once we have per-item edits from many clients, which is M5 at the earliest.

### 2.3 Migrations

- Put `apps/server/migrations/NNNN-name.sql` files in the repo. At startup, a small runner (about 30 lines, no dependency) reads `PRAGMA user_version`, applies each newer file in its own transaction and bumps `user_version`.
- Migrations are **forward-only**. A bad migration is fixed by a new migration, and backups are the rollback.
- The server **refuses to start** if the database's `user_version` is newer than the code knows. That catches a rollback to an old binary.
- Tests: an in-memory `:memory:` database per test. One test runs every migration from empty and checks the final schema. One test opens a fixture at version N-1 and upgrades it.

### 2.4 Restart semantics

On boot, the server loads every room row into the in-memory `Room` objects: layout plus embed, with playback paused at 0. The hot path is unchanged. `Room` keeps working purely in memory, and a thin `RoomStore` writes through on the rare mutations only: room created, layout set, embed changed. Writes are synchronous `bun:sqlite` calls of a few tens of µs in WAL mode, and none sits on the `control`/chat relay path.

### 2.5 Backup

- **Nightly:** a systemd timer runs `VACUUM INTO '/var/backups/omega-share/omega-<date>.db'`, which gives a consistent snapshot while the server keeps running. It keeps 14 days locally and copies each snapshot off the box (Hetzner Storage Box, or any S3-compatible bucket at cents a month for files this small).
- **Provider backups** (+20 %) are a second, whole-disk layer.
- **Restore drill** (an M4 acceptance item): stop the service, copy a snapshot to `DB_PATH`, start it, and check that the rooms and layouts are back.
- Later, if we want point-in-time recovery: Litestream (Apache-2.0), an external binary that replicates WAL to object storage. It is not needed while the data is a handful of rooms.
- The data is low-sensitivity: no IPs, no chat, no names. The backups still go to storage only the operator can reach.

## 3. Customizable rooms (start): proposed contract issue

**Proposed issue: "Contract: room layout v1 (furniture placement in the snapshot)"**, owned by the Lead in `packages/shared`. It blocks the server and web layout issues.

The smallest change set:

1. **Constants** (`constants.ts`): move `FLOOR_CELLS = 10` from `apps/web/src/layout.ts` into shared, and add `MAX_FURNITURE = 32`.
2. **`FurnitureKindSchema`** = `v.picklist(["armchair", "lamp", "plant", "rug", "tv"])`, the kinds the room atlas already has (`assets/room/room.json`). **`FacingSchema`** = `v.picklist(["ne", "nw", "se", "sw"])`.
3. **`FurnitureSchema`** = `{ kind, col: 0..FLOOR_CELLS-1, row: 0..FLOOR_CELLS-1, facing }`, integers only. There is no per-item id in v1: an item is identified by its index, and seats by armchair order (item 5).
4. **`RoomLayoutSchema`** = `{ furniture: array, maxLength MAX_FURNITURE }`, with checks:
   - exactly **`SEAT_COUNT` armchairs**, so the `seats[]` array and `SeatIndexSchema` keep their meaning and length;
   - exactly **one `tv`**;
   - no two non-`rug` items on the same cell;
   - a rug is 3×3 around its cell and fully on the floor.
5. **Seat binding:** seat `i` is the `i`-th armchair in `furniture` order. The web derives the seat points from the layout instead of `SEAT_CELLS`.
6. **`RoomStateSchema.layout`**: `v.optional(RoomLayoutSchema)`. **Optional**, so a pre-M4 server's snapshot still parses, and a client that gets no layout falls back to `DEFAULT_LAYOUT`.
7. **`DEFAULT_LAYOUT`**: today's room as data (the 8 `SEAT_CELLS` armchairs, the TV, the rug, the lamp and the plant). It is exported from shared, so the server seeds it and the web has a fallback. A contract test pins that it parses and that its seats equal today's `SEAT_CELLS`, so M4 renders the same room pixel for pixel.

**Not in the v1 contract** (deliberately):
- No client → server layout message, and no `layout-changed` broadcast. M4 layouts are set server-side: seed, room creation from the default, and an operator CLI. Every `strictObject` client message stays as it is, so there is no new abuse surface.
- No room creation endpoint. Creating rooms publicly without accounts invites room spam. It needs its own threat-model pass (caps, a per-key creation bucket, garbage-collecting empty rooms).

**Follow-up contract issue (M4-late or M5, CEO/board to sequence): "Contract: room ownership + layout editing".** It covers `POST /rooms` (create, rate-limited per key, global room cap), a per-room owner token minted at creation (the same shape and storage rules as the share token, ADR 0015 §7, never in a URL), a client message `layout-set { layout }` accepted only from the owner, and a server message `layout-changed { layout }`. With `MAX_FURNITURE = 32`, a full layout is about 1.5 KB, which fits `MAX_CLIENT_MESSAGE_BYTES` (4 KB). Snapshot size: the worst case is about 4.7 KB today, plus about 2 KB of layout, so about 6.7 KB, under `MAX_SERVER_MESSAGE_BYTES` (16 KB).

Compatibility: v1 is additive. An old web client strips the unknown `layout` key (server → client objects are non-strict, ADR 0016 §6) and renders its hard-coded room, which equals `DEFAULT_LAYOUT`. The site and server deploy together anyway (one origin). The extension parses neither, so it needs no change.

## 4. Safety and perf deltas for a public host

### 4.1 What carries over unchanged (with the recommended topology)

- **Client IP and rate limits:** Caddy appends the real peer to `X-Forwarded-For` and, by default, **ignores** incoming XFF values (no `trusted_proxies` configured). The server sees a loopback peer, so with `TRUST_PROXY=loopback` the rightmost entry is the real client (ADR 0015 §5). Every M3 limiter works as tested: per-socket, per-room, per-key join/upgrade/member caps (ADR 0018), the share buckets, the socket caps of 10 per key and 200 global, and `4029`/`4400`.
- **Host/Origin allowlists** (421/403) with `PUBLIC_ORIGIN=https://<domain>`. Caddy passes `Host` through unchanged.
- **Bind:** the server stays on `127.0.0.1` (the default, ADR 0015 §3). Caddy is the only way in, and the firewall closes 8787.
- **The CSP, security headers and same-origin `wss:`** come from the server (`apps/server/src/headers.ts`). Caddy must not add or override CSP headers. A proxy e2e test already checks that the headers reach the client.

### 4.2 What changes

| # | Delta | Where | Why |
|---|---|---|---|
| D1 | **HSTS** `max-age=31536000` (no `preload` yet), set only when `PUBLIC_ORIGIN` is set | server `headers.ts`, or Caddy | Real TLS on our own domain; the tunnel's domain wasn't ours to pin |
| D2 | **Enforce Trusted Types**: move `CSP_REPORT_ONLY` into the enforced CSP | server `headers.ts` + headed real-provider run | `headers.ts` says "enforce in M4 if the real-provider run is clean" |
| D3 | **No Cloudflare proxy** (DNS-only) in M4 | ops / ADR 0020 | Behind Cloudflare, the rightmost XFF entry would be a Cloudflare edge address. Every client in a region would share one key, and Caddy would need `trusted_proxies` for Cloudflare's ranges. Revisit only if we need DDoS shielding. |
| D4 | **Valibot-parse every DB row** (layout, embed) on read; refuse to start if a seed row fails | server `RoomStore` | The DB file is a boundary too: hand edits, restores, old versions |
| D5 | **DB outside `STATIC_DIR`**, file mode `0600`, owned by the service user; startup check that `DB_PATH` isn't inside `STATIC_DIR` | config + systemd unit | `serveStatic` must never be able to serve the database |
| D6 | **Access logs:** Caddy access log off, or kept 7 days at most; the app never logs IPs | Caddyfile | IPs are personal data (GDPR, EU host). Nothing in M4 needs them on disk |
| D7 | **systemd hardening**: `DynamicUser` or a dedicated user, `ProtectSystem=strict`, `ReadWritePaths=/var/lib/omega-share`, `NoNewPrivileges`, `MemoryMax=512M` | deploy | Limits the blast radius of a server bug |
| D8 | **Pings vs middleboxes:** keep `sendPings` (ADR 0018 §4). No intermediate idle timeout exists in this topology. Any future proxy (Cloudflare 100 s) is covered by the 60 s idle timeout and pings | server (no change) | Documented so a later move doesn't silently break long idle rooms |
| D9 | **AGPL §13 "Source" link** in the site footer | web | Network-use source offer |
| D10 | **Global caps** (200 sockets, share 20/2 s⁻¹) stay. Add `MAX_ROOMS` before any room creation exists | server | One small box; caps protect the host as well as the rooms |

### 4.3 Perf-budget risk

- **Budgets unchanged:** they are measured on localhost and stay merge-blocking as they are.
- **New, informational only:** after each deploy, QA runs the relay-latency probe and one headed real-provider sync check against the hosted origin, and records RTT, relay latency and sync spread. It doesn't block merges, because the network isn't under our control.
- **TTI over a real network:** the site is ≤ 200 KB gz. Caddy `encode zstd gzip` plus HTTP/2, and the server's existing `immutable` cache on `/assets/*` (`static.ts`), keep a repeat visit to one HTML request. Risk: low.
- **Layout rendering:** furniture becomes data instead of constants. Static furniture must stay in the existing batched container, rendered once per layout change, never rebuilt per frame. Depth-sorting with avatars reuses the front/back armchair frames. Risk: low, covered by the existing frame and missed-vsync budgets (ADR 0017), which QA reruns on the web layout issue.
- **SQLite on the relay path:** none by design (§2.4). A test pins that `control` and `chat` handling never touches the store.
- **Box size:** 2 vCPU / 4 GB is far above what 25 people per room needs (the load test runs on one laptop core). On a 512 MiB droplet fallback, never build on the box.

## 5. Cost table (for the board)

Monthly, at our scale (< 50 concurrent users, a few GB egress, a DB of a few MB). Prices from provider pages, checked 2026-10-01. *(s)* = from a secondary source; re-check on the order page.

| Item | **Hetzner CX23 (recommended)** | Hetzner CPX12 (if CX23 sold out) | Fly.io | Railway | DigitalOcean $4 |
|---|---|---|---|---|---|
| Compute | €5.49 | ≈ €11.99 *(s)* | ≈ $3.34 | $5 (incl. $5 usage) | $4.00 |
| IPv4 | ≈ €0.50 | ≈ €0.50 | free shared / $2 dedicated | incl. | incl. |
| Storage for SQLite | incl. (local disk) | incl. | ≈ $0.15 (1 GB volume) | ≈ $0.15 | incl. |
| Backups | ≈ €1.10 *(s)* (20 %) | ≈ €2.40 *(s)* | snapshots ≤ 10 GB free | — | $1.20 (daily, 30 %) |
| Off-box backup copy | < €0.10 (object storage, MB-sized) | < €0.10 | < $0.10 | < $0.10 | < $0.10 |
| TLS | free (Caddy, ACME) | free | free | free | free (Caddy) |
| **Monthly total** | **≈ €7.20 (≈ $8.40)** | ≈ €15.00 | ≈ $3.60–5.60 | ≈ $5.15 | ≈ $5.30 |
| **Yearly** | **≈ €86** | ≈ €180 | ≈ $43–67 | ≈ $62 | ≈ $64 |
| Engineering cost beyond the common work | none (today's trust path) | none | new client-IP trust mode + tests | new client-IP trust mode + tests | none (512 MiB: build off-box) |
| Lock-in | none | none | low–moderate | low | none |

Plus, for every option, **one domain**: ≈ $10–15 a year (registrar's choice, a board decision).

**Ask for the board:** approve up to **€10/mo (≈ $12) plus one domain (≈ $15/yr)** for Hetzner CX23 or CAX11. If it is unavailable, approve the DigitalOcean $4 droplet with daily backups at the same ceiling, or CPX12 at up to €15/mo. Name the account holder. Credentials go into Paperclip secrets only.

## 6. Proposed M4 issue list (for the CEO's plan, after M3 approval)

Dependencies are shown with →. Each engineering issue is TDD (failing-test commit first).

| # | Issue | Owner | Depends on |
|---|---|---|---|
| 1 | **Board approval:** hosting spend + domain (§5) | CEO → board | M3 approval |
| 2 | **ADR 0020: hosted topology** (VPS + Caddy + systemd, DNS-only, supersedes the tunnel part of ADR 0015 §1) | Lead | 1 |
| 3 | **Contract: room layout v1** (§3, `packages/shared`) | Lead | M3 approval |
| 4 | **Server: SQLite store** (`bun:sqlite`, WAL, migration runner, `rooms` table, `DB_PATH` config + checks D4/D5, Valibot on read) | Lead (or implementer) | 3 |
| 5 | **Server: rooms and layout from the DB** (seed `lobby` with `DEFAULT_LAYOUT`, `snapshot.layout`, persist and restore the embed paused at 0, the store never on the relay path) | Lead | 4 |
| 6 | **Web: render the layout from the snapshot** (furniture and seats from data, fallback `DEFAULT_LAYOUT`, batched static layer, perf rerun) | Lead | 3 (5 for e2e) |
| 7 | **Server: public-host headers** (HSTS when `PUBLIC_ORIGIN` is set, D1; enforce Trusted Types, D2, after a clean headed real-provider run) | Lead + QA | M3 approval |
| 8 | **Web: AGPL "Source" link** (D9) | Lead | — |
| 9 | **Ops: provision + deploy** (VPS, firewall, Caddy, systemd unit with D7 hardening, deploy script, Bun pin, secrets in Paperclip) | Lead with the operator / CEO for account access | 1, 2 |
| 10 | **Ops: backups + restore drill** (nightly `VACUUM INTO`, off-box copy, a drill documented in `docs/ops/`) | Lead | 4, 9 |
| 11 | **QA: hosted smoke + informational perf** (e2e against the hosted origin, relay probe, headed real-provider run under xvfb, the RTT/spread record) | QA | 5, 6, 9 |
| 12 | *(M4-late or M5)* **Contract + threat model: room ownership and layout editing** (`POST /rooms`, owner token, `layout-set` / `layout-changed`, `MAX_ROOMS`, empty-room GC) | Lead | 3, CEO sequencing |

Open questions for the CEO/board: (a) where most users are (that decides EU or US), (b) whether to keep the M2 tunnel as a fallback after M4, which I recommend keeping as a documented operator path, (c) whether issue 12 belongs in M4 or M5.
