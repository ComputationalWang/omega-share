# M1b real-YouTube checklist (QA sign-off; rerun at M2 and nightly)

CI never touches YouTube (the e2e suite stubs it with the fake IFrame API, `e2e/fixtures/fake-iframe-api.ts`). This checklist covers what only the real player shows. The items come from `docs/research/m1b-youtube-sync.md` §4.3. Owner: QA.

## How to run

```sh
bunx playwright install chromium        # once
bun run e2e:real                        # headed Chromium, real network; starts the dev web app + server like `bun run e2e`
OMEGA_WEB_PORT=5191 OMEGA_SERVER_PORT=8797 OMEGA_FIXTURE_PORT=4491 bun run e2e:real   # if 5173/8787 belong to someone else
```

- Spec: `e2e/real/real-youtube.real.ts`, helpers in `e2e/real/real.ts`. Project `e2e-real` in `playwright.config.ts`. It's never part of `bun run e2e` or CI.
- It needs a display (headed), and it uses the **dev** web build, because it reads `window.__omega.room.playback()`.
- Evidence: `e2e/real/results/<item>.json` and `.png` (git-ignored; Playwright empties `test-results/` on every run). Attach them to the sign-off issue.
- Video IDs can be overridden when YouTube changes them: `OMEGA_REAL_NOEMBED_ID`, `OMEGA_REAL_AGE_ID`, `OMEGA_REAL_AD_IDS` (comma-separated).
  - To find a fresh embedding-disabled ID: `curl "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=<id>"` returns **401**, and the watch page has `"playableInEmbed":false`.
  - An age-gated one has `"status":"LOGIN_REQUIRED","reason":"Sign in to confirm your age"`.
- The spec reads the real `<video>` inside the cross-origin player iframe (`currentTime`, `playbackRate`, `muted`, `.ad-showing`). It never changes what the site does.

## Checklist

| # | Check | How the spec checks it | Pass when |
|---|---|---|---|
| 1 | A pre-roll ad on a monetized video: the room doesn't pause, and the client catches up | 2 clients. Share each of `OMEGA_REAL_AD_IDS` in turn and watch `.ad-showing` in both players. | The room stays playing through the ad, and the spread is < 1 s 6 s after the ad. **Skipped if no ad is served.** Ads can't be forced, so check by hand when that happens. |
| 2 | Embedding-disabled (101/150) and age-restricted videos show a clear notice | Share `NOEMBED_ID` and `AGE_ID`. Read YouTube's in-player text and our visible notices. | Any video that doesn't play has a **site** notice saying why, and the transport is frozen (`playing` and `canControl` false). YouTube's own text alone doesn't count, because our transport would still say "playing". A video YouTube lets through needs no notice. |
| 3a | Sound after "Enter room" | Playwright, with a real click on Enter. | The `<video>` isn't muted, volume > 0, and `needsUnmute` is false. |
| 3b | The muted fallback and Unmute work | A Chromium that Playwright does **not** drive (raw CDP, every script `userGesture: false`). Playwright gives every page a user activation within about 20 ms, so that path can't reach this state. The spec clicks Unmute with a trusted CDP mouse event. | With no activation, the video plays muted and `needsUnmute` is true. The Unmute button shows. After the click, the video is unmuted and the button is hidden. |
| 4 | The nocookie host works with the API attached | The TV iframe `src`, the adapter's `onReady` (`hasVideo`), and our transport pausing and resuming the real `<video>`. | The src is on `www.youtube-nocookie.com` and pause/resume take effect within 5 s. If it fails, flip `USE_NOCOOKIE` in `apps/web/src/tv.ts` (a Lead Engineer bug). |
| 5 | Effective rate at 1.05, and which rung is active | (a) Raw player: `setPlaybackRate(1.05)`, then the slope of `getCurrentTime()` over 30 s and `video.playbackRate` in the iframe. It also replays the sync loop's own 2 s check (`nextRateMode`) on the rates the loop sends (0.95/1.05/0.9/1.1, YouTube's 0.05 grid, ADR 0013), and records what off-grid rates really play at (YouTube floors them toward 1). (b) In the room: after joining, and after pushing one client +0.6 s, record which rates the loop uses. | The slope is 1.05 ± 0.01 and `video.playbackRate` is 1.05. The replayed check never downgrades a working fine rate. The room is on the **fine** rung (nudges ≤ 10 %, never 0.75/1.25). |
| 6 | Buffering under DevTools "Slow 4G" | CDP `Network.emulateNetworkConditions` on the page **and** on the player's out-of-process iframe (562.5 ms latency, 1.44 Mbps down, 675 kbps up), plus a seek to force fresh fetches. | The room never pauses. After the throttle is lifted, the spread is < 500 ms. |
| 7 | Two real browsers | Two separate Chromium processes with their own profiles, on one machine. Spread is sampled 20 × 500 ms steady, then after a pause and play from browser 1. | The spread is ≤ 500 ms (the `docs/perf-budgets.md` Sync row), and both browsers pause at the same position. |
| 8 | The path-scoped CSP loads the current `www-widgetapi.js` | The response for `/s/player/<hash>/www-widgetapi.vflset/www-widgetapi.js` and `securitypolicyviolation` events in our document. | The widget script returns 200, there are 0 CSP violations, and the "without sync" notice stays hidden. Record the hash. |

Not automated: two *machines* (item 7 runs on one). After M2, rerun item 7 over the ngrok tunnel from a second machine.

M2 ([OME-133](/OME/issues/OME-133)): the item 1 spec now also probes the same ids as a raw `www.youtube.com` embed, as a control. Twitch, Vimeo and the real tunnel are in [`m2-real-sign-off.md`](m2-real-sign-off.md), and that file has the 2026-09-30 rerun of this checklist.

## Results

Newest first. Earlier runs stay for comparison.

### 2026-09-30 (rerun) · `main` @ 2699ee1 (OME-109, OME-110, OME-111 merged) · same browser · QA ([OME-91](/OME/issues/OME-91))

| # | Result | Evidence |
|---|---|---|
| 1 | **Not observed.** 0 of 6 candidates served an ad on the nocookie host, and the room stayed playing. Covered offline by the fake player's `ad(ms)` in `e2e/sync.e2e.ts`. | `01-ads.json` |
| 2 | **PASS.** Embedding-disabled `s5qx1X78ujE`: the site notice reads "This video can't play here: the owner doesn't allow playback on other sites.", and the transport is frozen (`playing: false`, `canControl: false`). YouTube's own "Video unavailable" stays visible in the player. The age-restricted `fVs0suPHAX8` again played ungated for this viewer. | `02-errors.json`, `02-noEmbed.png` |
| 3a | **PASS.** A real Enter click gives sound (`muted: false`). | `03-sound.json` |
| 3b | **PASS.** With no activation: muted and playing, `needsUnmute: true`, Unmute shown. After the click: unmuted and the button is hidden. | `03-muted-fallback.json`, `.png`, `03-after-unmute.png` |
| 4 | **PASS.** nocookie src, adapter attached, and our transport pauses and resumes the real video. | `04-nocookie.json` |
| 5 | **PASS · rung `fine`.** Raw: slope over 30 s at 1.05 is **1.050**, and `video.playbackRate` is 1.05. The loop's 2 s check replayed on the grid rates never downgrades (0.95→0.943, 1.05→1.036, 0.9→0.893, 1.1→1.086; 8/8 `fine`, each playing exactly as sent). YouTube floors off-grid rates: 1.02 and 1.03 play at **1**, 0.98 and 0.97 at **0.95**. In the room: 1.05 after the join, the +0.6 s drift corrected at 0.9, no 0.75/1.25 bursts, spread 174 ms. | `05-rate.json`, `05-rate-raw.json` |
| 6 | **PASS.** Under Slow 4G the room stayed playing (59/59 samples). The slow client was "catching up" for about 2 s. Spread 168 ms throttled, 166 ms after. | `06-slow4g.json` |
| 7 | **PASS.** Two Chromium processes with separate profiles, one machine. Steady worst is 182 ms. The pause landed on the same frame (0 ms). 38 ms after play. | `07-two-browsers.json`, `07-browser-*.png` |
| 8 | **PASS.** `/s/player/57bae81f/www-widgetapi.vflset/www-widgetapi.js` returned 200, with 0 CSP violations. | `08-csp.json` |

### 2026-09-30 · `main` @ b20a441 · Chrome for Testing 153.0.8010.12 (Playwright 1.63.0), headed, Linux/Wayland · QA ([OME-91](/OME/issues/OME-91))

| # | Result | Evidence |
|---|---|---|
| 1 | **Not observed.** None of the 6 candidates served an ad on the nocookie host (`dQw4w9WgXcQ`, `kJQP7kiw5Fk`, `JGwWNGJdvx8`, `OPf0YbXqDm0`, `09R8_2nJtjg`, `fRh_vgS2dFE`). The room stayed playing throughout. The ad guard is covered offline by `e2e/sync.e2e.ts` (fake `ad(ms)`). | `01-ads.json` |
| 2 | **FAIL.** Embedding-disabled `s5qx1X78ujE`: YouTube shows "Video unavailable · Playback on other websites has been disabled by the video owner", but the site shows no notice. Our transport keeps "Pause for everyone" and the clock ticks (`playing: true`, duration `--:--`). The `error` player event is dropped in `apps/web/src/controls/playback.ts` (`case "error": return;`). The age-restricted candidate `fVs0suPHAX8` played in the embed, so this viewer saw no gate and no notice was needed. | `02-errors.json`, `02-noEmbed.png`, `02-ageRestricted.png` |
| 3a | **PASS.** After a real Enter click the video plays with sound: `muted: false`, volume 1, `needsUnmute: false`. | `03-sound.json` |
| 3b | **PASS.** With no activation (`hasBeenActive: false`), `onAutoplayBlocked` fired and the video played muted (`muted: true`, `paused: false`). Unmute showed. After a trusted click: `muted: false`, `needsUnmute: false`, button hidden. | `03-muted-fallback.json`, `03-muted-fallback.png`, `03-after-unmute.png` |
| 4 | **PASS.** src `https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ?enablejsapi=1&origin=…&controls=0&disablekb=1&playsinline=1&rel=0&autoplay=1`. The adapter attached, and our transport paused and resumed the real video. | `04-nocookie.json`, `04-nocookie.png` |
| 5 | **FAIL (wrong rung).** Raw player: rates `[0.25…2]`, 1.05 reported as 1.05, `video.playbackRate` 1.05, slope over 30 s **1.050** (1.000 at 1×), so fine rates really apply. But the loop's 2 s check replayed on the real player downgrades on every speed-up: 1.02 → slope 0.9999, 1.03 → 1.000 (4/10 windows → `burst`). Slow-downs over-read: 0.98 → 0.94. In the room the loop is on **burst**: 1.25 about 3 s after joining, and 0.75 for a +0.6 s drift. Fine is never used. | `05-rate.json`, `05-rate-raw.json` |
| 6 | **PASS.** Under Slow 4G the room stayed playing in all 59 samples (every 0.5 s for 30 s). The slow client showed "catching up" for about 1.5 s. Spread while throttled was 157 ms, and 161 ms after the throttle was lifted. | `06-slow4g.json`, `06-slow4g.png` |
| 7 | **PASS.** Two Chromium processes with separate profiles, one machine. Steady spread: worst 133 ms at the first sample, then within ±40 ms. After pause/play from browser 1: both paused at the same frame (0 ms difference), then 28 ms worst. | `07-two-browsers.json`, `07-browser-1.png`, `07-browser-2.png` |
| 8 | **PASS.** `https://www.youtube.com/s/player/57bae81f/www-widgetapi.vflset/www-widgetapi.js` returned 200 (the same hash as the research spike). 0 CSP violations, and the "without sync" notice stayed hidden. | `08-csp.json` |
