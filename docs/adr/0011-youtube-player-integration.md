# ADR 0011 — YouTube player integration

**Status:** accepted (2026-09-30) · [OME-83](/OME/issues/OME-83) · research in `docs/research/m1b-youtube-sync.md` (§2.3, §3, §6) · contract in `packages/shared/README.md`

**Context:** M1b plays the shared embed in sync (ADR 0002). We need to control the player (play, pause, seek, read time) without weakening the "never render arbitrary iframes" rule (ADR 0003), and keep the spread between clients ≤ 500 ms (`docs/perf-budgets.md`).

**Decisions:**
- **Official IFrame API, attached to our own iframe.** `tvFrame()` (`apps/web/src/tv.ts`) stays the only iframe builder. The API only attaches to that element (`new YT.Player(iframeElement)`). We never call `new YT.Player(div, { videoId })`, because that lets the API choose the src, sandbox and `allow` list.
- **Path-scoped `script-src`.** The CSP adds `https://www.youtube.com/iframe_api https://www.youtube.com/s/player/`, not the whole host. `frame-src` adds `https://www.youtube-nocookie.com`. The adapter issue must verify the path-scoped form loads the current `www-widgetapi.js`; the fallback is host-level `https://www.youtube.com`, recorded here if used. **Verified 2026-09-30 ([OME-88](/OME/issues/OME-88)):** against live YouTube in headless Chromium, the path-scoped form loads `/iframe_api` → `/s/player/57bae81f/www-widgetapi.vflset/www-widgetapi.js` with zero CSP violations, and `onReady` fires for both the nocookie and `www` hosts, so the host-level fallback is not used. The script is inserted once per page, only when an embed is non-null. A 10 s load timeout falls back to "video without sync" with a notice.
- **Nocookie host swap inside `tvFrame()`.** This clarifies ADR 0003: the wire `Embed.url` stays canonical (`https://www.youtube.com/embed/<id>`) and `EmbedSchema` still rejects anything else. `tvFrame()` parses the embed, then *derives* the src from it: the host may be swapped to the constant `https://www.youtube-nocookie.com`, and fixed query parameters are added (`enablejsapi=1`, `origin=location.origin`, `controls=0`, `disablekb=1`, `playsinline=1`, `rel=0`, `autoplay=1`). No other string ever becomes a src.
- **Sandbox** becomes `allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox`, so the YouTube logo/title links and ad click-through work. Popups open a new browsing context that can't navigate our tab. Still excluded: `allow-forms`, `allow-top-navigation*`, `allow-modals`, `allow-storage-access-by-user-activation`. `allow` stays `autoplay; encrypted-media; picture-in-picture; fullscreen`, and `referrerpolicy` stays `strict-origin-when-cross-origin`.
- **`controls=0` plus our own control bar** outside the player rect (YouTube policy forbids overlays on the player). Room actions go through `control`; the player's own UI is hidden so every user action becomes a room action.
- **Clock and sync thresholds** (§2.3). The clock offset comes from app-level `ping`/`pong` (min-RTT of 8 samples, reject RTT > 500 ms):

  | Term | Value |
  |---|---|
  | Clock offset error | ≤ 25 ms |
  | Dead band (no correction) | ±100 ms |
  | Nudge with playback rate | 100 ms – 1 s |
  | Seek (steady play) | > 1 s |
  | Hard seek | always, on an explicit action, a join or an embed change |

- **Wire contract** (OME-83): `PlaybackState { playing, position, rate, at, rev, action, by }` in `RoomState.playback` and `embed-changed.playback` (null iff no embed), `ping`/`pong`, `control`, `playback`, and error `no_embed`. `playback` is optional on the client (absent from a pre-M1b server = null).

**Why:** reimplementing the undocumented postMessage protocol is brittle, and YouTube's terms forbid player changes the API doesn't document. Attaching to our own element keeps src/sandbox/allow under our control. The spike (§5) showed the API costs about 12 KB of scripts loaded after join, 0.5 MB of heap, and no long tasks or frame-time change.

**Accepted risk:** first-party YouTube code now runs in our origin and can reach the DOM and the WebSocket. The path-scoped CSP narrows it to the two script paths the loader uses. If we ever enforce Trusted Types, we must allow the `youtube-widget-api` policy.

**Consequences:** the TV must be at least 200×200 CSS px after scaling (YouTube RMF). Chat bubbles, tags and the control bar must never intersect the TV rect. Both are owned by the M1b web/layout issues.
