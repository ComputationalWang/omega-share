# Real Vimeo SDK fixture (OME-164)

- `player.js`: an unmodified copy of `@vimeo/player` **v2.30.4** as served at `https://player.vimeo.com/api/player.js`. MIT License, (c) Vimeo, see `LICENSE`. sha256 `718e1ff73387fc5fd0455ca05339e322669afa1c952634094f5afb645cd52034`. Pinned so the forged-postMessage cases in `e2e/vimeo.e2e.ts` test the SDK's own origin and source checks offline.
- `embed.html`: a small stub of the player side of the Vimeo postMessage protocol, served for `player.vimeo.com/video/*`. It answers `ping`, `getVideoId`, `getDuration`, `getCurrentTime`, `setPlaybackRate`, `play`, `pause` and `setCurrentTime`, sends `timeupdate` every 250 ms, logs calls in `window.__methods`, and posts any event through `window.__emit(event)`.

Served by `serveRealVimeoSdk(context)` in `e2e/support/network.ts`. To update, replace `player.js` with the new served file, record its version and sha256 here, and rerun `e2e/vimeo.e2e.ts`.
