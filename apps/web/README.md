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
- `tv.ts`: the only place a frame is decided. `tvFrame` takes the synced tier: the embed must parse as `EmbedSchema`, and the YouTube and Vimeo iframes are sandboxed with `allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox` (no forms, modals or top navigation). `genericFrame` takes the generic tier (ADR 0024): the embed must parse as `GenericEmbedSchema` and its host must not be this page's host or under it. Its iframe has fixed `sandbox="allow-scripts allow-same-origin allow-presentation"`, `allow="fullscreen; autoplay"` and `referrerpolicy="no-referrer"`. `controls/generic-tv.ts` shows it as a click-to-load card first, so nothing third-party loads until that viewer clicks Load. The CSP in `index.html` limits `frame-src` to the three player hosts plus `https:` for the generic tier.

## Test ids
`nickname-input`, `nickname-error`, `avatar-option` ×4, `join-button`, `room`, `seat` ×8 (`data-seat`, `data-occupied`), `nickname-tag`, `room-notice` (server errors like seat_taken, 3 s), `chat-input`, `chat-message` (bubble), `shared-video` (iframe), `generic-card`, `generic-load`, `not-synced`, `generic-hint` (generic tier), `room-full`, `connection-status`.

In dev builds only, `window.__omega` is `{ roomId, room: { state(), send() } | null }`.
