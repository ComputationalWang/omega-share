# @omega/web

Vite + PixiJS site. Wire contract: `packages/shared` (ADR 0003).

```sh
bun run --filter @omega/web dev        # http://localhost:5173, expects apps/server on :8787
bun run --filter @omega/web build      # → apps/web/dist
bun run --filter @omega/web preview
```

| Env | Default | |
|---|---|---|
| `VITE_SERVER_URL` | `<page protocol>//<page host>:8787` | base URL of `apps/server`; the socket is `<base>/rooms/<room>/ws` |

Rooms live at `/r/<room>`. Other paths, and invalid ids, use `lobby`.

## Shape
- `main.ts`: landing (nickname + avatar + Enter). This is the only initial JS. The room chunk (PixiJS) is loaded on Enter, and warmed when the form gets focus or hover.
- `state.ts`: pure reducer from server messages and connection events to `ViewState`. `intents.ts` turns clicks and chat input into `ClientMessage`s.
- `connection.ts`: one WebSocket. It re-`join`s with 0.5 → 5 s jittered backoff and a 10 s handshake timeout. It stops on `room-full` or `close()` (on `pagehide`), and `resume()`s on a bfcache restore.
- `room.ts`: DOM wiring. Seats, nickname tags, bubbles and the TV are DOM over the canvas. `room-view.ts` holds the Pixi floor, seats and placeholder avatars. It renders on demand (ticker stopped), so an idle room does no per-frame work.
- `tv.ts`: the only place an iframe is built. The embed must parse as `EmbedSchema` (canonical `https://www.youtube.com/embed/<id>`). The iframe is sandboxed with `allow-scripts allow-same-origin allow-presentation`. There are no popups, forms or top navigation. The CSP in `index.html` also limits `frame-src` to `https://www.youtube.com`.

## Test ids
`nickname-input`, `nickname-error`, `avatar-option` ×4, `join-button`, `room`, `seat` ×8 (`data-seat`, `data-occupied`), `nickname-tag`, `room-notice` (server errors like seat_taken, 3 s), `chat-input`, `chat-message` (bubble), `shared-video` (iframe), `room-full`, `connection-status`.

In dev builds only, `window.__omega` is `{ roomId, room: { state(), send() } | null }`.
