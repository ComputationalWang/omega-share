# @omega/server

Bun + Hono on `Bun.serve` with built-in WebSockets and Bun pub/sub (one topic per room). State is in memory: one room, `lobby` (`DEFAULT_ROOM_ID`). Wire contract: `packages/shared` (ADR 0003). Capacity: ADR 0006. Share auth: ADR 0007.

## Run

```sh
bun run --filter @omega/server start   # or `dev` to restart on file changes
```

`GET /` answers 200 as a readiness probe (Playwright's `webServer` waits on it).

| Env | Default | |
|---|---|---|
| `PORT` | `8787` | `0` picks an ephemeral port |
| `HOST` | all interfaces | e.g. `127.0.0.1` |
| `SITE_ORIGIN` | `http://localhost:5173` | the only web origin allowed, besides `chrome-extension://<32-char id>` |

## API

- `GET /rooms` → `RoomListResponse`
- `POST /rooms/:id/share` with `{ url }` → `ShareResponse`. The server runs `canonicalizeEmbed` itself. Returns 400 `invalid_body` / `unsupported_url`, 404 `room_not_found`, 413 `payload_too_large` (> 4 KB), and 403 for a foreign `Origin`. On success, it broadcasts `embed-changed` (`by: null`) with the new embed's `load` playback.
- `GET /rooms/:id/ws` upgrades to a WebSocket. Unknown room → 404, foreign `Origin` → 403. Every frame is parsed with `parseClientMessage`. Invalid frames get `error bad_message` and are otherwise ignored. Frames over 4 KB close the socket (`maxPayloadLength`).

## Playback (ADR 0011)

- `ping{id}` → `pong{id, at}` to the sender only, via `ws.send`. It is allowed before `join` and counts against the socket's token bucket.
- Each room holds `playback` (null iff there is no embed). A share resets it to `{playing: true, position: 0, action: "load", by: null}`. `rev` rises by 1 per change, including across embed changes.
- `control{videoId, playing, position}` needs `join`. A `videoId` that isn't the current embed gets `error no_embed`. Otherwise the server stores `{playing, position, at: Date.now(), rev + 1, action, by}` (last write wins) and publishes `playback` to the room. `action` is `seek` when `position` is more than 1 s from the extrapolated position, else `play`/`pause`. Positions are clamped to `[0, MAX_POSITION_S]`.
- The snapshot carries `room.playback`. The pure rules live in `src/playback.ts`.

CORS allows only the site origin and extension origins. Requests with no `Origin` (curl, tests) are allowed, because they are not a cross-site risk. The 403 (foreign origin), 429 on upgrade and Bun's transport-level 413 (> 64 KB) are plain text, not `ShareResponse`: check `res.ok`/status before parsing.

`chrome-extension://*` currently accepts any extension id. Pin it to our published id once it exists.

## Abuse limits

| Limit | Value |
|---|---|
| Join timeout: a socket that doesn't `join` is closed (1008) | 10 s (`joinTimeoutMs`) |
| WebSockets per client address | 50 (`maxConnectionsPerIp`), then upgrade → 429 |
| WS messages per socket | burst 20, 10/s; excess → `error rate_limited`, dropped |
| `control` per socket (on top of the above) | burst 4, 4/s; excess → `error rate_limited`, dropped |
| Shares per client address | burst 5, then 1 per 3 s → 429 `rate_limited` |
| Share body | 4096 UTF-8 bytes, counted while streaming |

Limits are keyed by the socket peer address. IPv6 is keyed by its /64, and at most 1024 share keys are kept (least recently used evicted). `X-Forwarded-For` is ignored on purpose, so it can't be spoofed. **Expose the server directly.** Behind a reverse proxy every user shares the proxy's address and hits the per-address caps together. A trusted-proxy option is needed before any proxied deploy.

A rate-limited socket gets one `error rate_limited` per streak. Further dropped frames get no reply until it slows down.

`POST /rooms/:id/share` needs no membership or token in M1a; see ADR 0007.

## Relay latency hook (perf budget ≤ 50 ms)

`measureRelayLatency({ url, clients, samples })` in `src/relay-latency.ts` joins N sockets. It times one member's `sit` until the last socket receives the `seat-changed`, and returns `{ p50, p95, max }` in ms. Against a running server:

```sh
bun run --filter @omega/server bench:relay -- --url ws://127.0.0.1:8787/rooms/lobby/ws --clients 25 --samples 200
```

It prints JSON (`pass: p95 <= --budget`, default 50) and exits 1 on a miss. The acting member rotates across the sockets so the per-socket rate limit doesn't skew the numbers. The lobby must have room for `--clients` more members. The `bun test` suite runs the same probe with 25 clients.

`--action control` (option `action: "control"`) times a `control` seek until every socket gets the matching `playback`. The room needs an embed, and `clients × 4 ≥ samples + 1`, because of the control limit. Afterwards it restores the playback it found (extrapolated with the probe's clock), so a live room jumps briefly. The test suite runs it with 25 clients.

## Not yet

Multiple rooms.
