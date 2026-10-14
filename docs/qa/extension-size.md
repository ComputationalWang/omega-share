# Extension bundle size

[OME-1102](/OME/issues/OME-1102). Chromium MV3 production build of 0.1.1 (`cd apps/extension && bunx wxt build`), sizes of `.output/chrome-mv3`. Raw is bytes on disk, gz is `gzip -9c | wc -c`. "Before" is `main` at `301ae3f`, "after" is this branch.

## Per chunk

| File | Loaded by | Raw before | gz before | Raw after | gz after |
|---|---|---:|---:|---:|---:|
| `chunks/popup-*.js` | popup | 11,092 | 4,663 | 15,652 | 6,566 |
| `chunks/settings-*.js` | popup, options | 20,654 | 8,043 | 12,099 | 4,711 |
| `chunks/generic-embed-*.js` | popup, options, consent | 16,785 | 5,017 | 15,683 | 4,835 |
| `chunks/options-*.js` | options | 1,871 | 973 | 1,871 | 975 |
| `chunks/consent-*.js` | consent | 1,701 | 972 | 1,706 | 972 |
| `background.js` | service worker | 19,768 | 7,144 | 18,324 | 6,538 |
| `content-scripts/bridge.js` | our site only (ADR 0047) | 15,155 | 5,516 | 13,717 | 4,905 |
| `content-scripts/found.js` | opt-in found indicator | 14,974 | 5,731 | 13,540 | 5,090 |
| `popup.html` | popup | 3,363 | 1,195 | 3,363 | 1,198 |
| `popup/kit.css` | popup | 13,422 | 3,395 | 13,422 | 3,395 |
| `assets/popup-*.css` | popup | 519 | 335 | 519 | 335 |
| `options.html` | options | 2,299 | 1,085 | 2,299 | 1,090 |
| `consent.html` | consent | 1,246 | 725 | 1,246 | 727 |

Chunk boundaries moved: the popup chunk now holds the share/queue/rooms code that used to sit in `settings`, which options no longer has to load.

## Per page (JS only)

| Page | gz before | gz after |
|---|---:|---:|
| Popup (popup + settings + generic-embed) | 17,723 | **16,112** (−1,611, −9 %) |
| Options (options + settings + generic-embed) | 14,033 | 10,521 (−3,512) |
| Consent (consent + generic-embed) | 5,989 | 5,807 |

## What changed

`@omega/shared` has only top-level declarations, but its `package.json` leaves `sideEffects` unset. The bundler therefore kept every module the barrel re-exports, so the popup shipped room, layout, report and room-ownership schemas (furniture, presets, standing slots). It did that because `RoomIdSchema` lives in `room.ts`. Importing a narrower set from the extension can't fix this, because the extension uses `RoomIdSchema`. `wxt.config.ts` now tells the bundler that `packages/shared/**` modules have no side effects. Setting `"sideEffects": false` in `packages/shared/package.json` gives the same popup number, but that file is owned by the Lead (contract-first).

## Proposed budget row

For `docs/perf-budgets.md`, pending the Lead's approval:

| Area | Metric | Budget |
|---|---|---|
| Extension | Popup JS (gzipped, every chunk `popup.html` loads) | ≤ 20 KB |

16.1 KB today (15.8 KB at Bun's default gzip level) leaves about 20 % headroom. `bun run perf` records it as `ext.popupJsGzip`. It is a static check on the shipped `chrome-mv3` build, summing the entry script and modulepreloads in `popup.html` (`perf/static-checks.ts` `initialJsGzipKb`).
