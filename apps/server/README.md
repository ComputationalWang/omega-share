# @omega/server

Bun + Hono on `Bun.serve` with built-in WebSockets and Bun pub/sub (one topic per room). State is in memory: one room, `lobby` (`DEFAULT_ROOM_ID`). Wire contract: `packages/shared` (ADR 0003). Capacity: ADR 0005.

## Run

```sh
bun run --filter @omega/server start
```

| Env | Default | |
|---|---|---|
| `PORT` | `8787` | `0` picks an ephemeral port |
| `HOST` | all interfaces | e.g. `127.0.0.1` |
| `SITE_ORIGIN` | `http://localhost:5173` | the only web origin allowed, besides `chrome-extension://<32-char id>` |

## API

- `GET /rooms` → `RoomListResponse`
- `POST /rooms/:id/share` with `{ url }` → `ShareResponse`. The server runs `canonicalizeEmbed` itself. Returns 400 `invalid_body` / `unsupported_url`, 404 `room_not_found`, 413 `payload_too_large` (> 4 KB), and 403 for a foreign `Origin`. On success, it broadcasts `embed-changed` (`by: null`).
- `GET /rooms/:id/ws` upgrades to a WebSocket. Unknown room → 404, foreign `Origin` → 403. Every frame is parsed with `parseClientMessage`. Invalid frames get `error bad_message` and are otherwise ignored. Frames over 4 KB close the socket (`maxPayloadLength`).

CORS allows only the site origin and extension origins. Requests with no `Origin` (curl, tests) are allowed, because they are not a cross-site risk.

## Relay latency hook (perf budget ≤ 50 ms)

`measureRelayLatency({ url, clients, samples })` in `src/relay-latency.ts` joins N sockets. It times one member's `sit` until the last socket receives the `seat-changed`, and returns `{ p50, p95, max }` in ms. Against a running server:

```sh
bun run --filter @omega/server bench:relay -- --url ws://127.0.0.1:8787/rooms/lobby/ws --clients 25 --samples 200
```

It prints JSON (`pass: p95 <= --budget`, default 50) and exits 1 on a miss. The `bun test` suite runs the same probe with 25 clients.

## Not yet

Rate limiting (`rate_limited` is reserved in the contract), playback sync (ADR 0002), and multiple rooms.
