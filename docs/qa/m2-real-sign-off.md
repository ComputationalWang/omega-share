# M2 real-world sign-off: Twitch, Vimeo, a public tunnel, YouTube pre-roll (QA; rerun at each milestone)

CI never touches the real providers or a real tunnel. The fake-SDK suites (`e2e/provider-sync.e2e.ts`, `e2e/vimeo.e2e.ts`) and the local-proxy tunnel suite (`e2e/tunnel*.e2e.ts`, [OME-132](/OME/issues/OME-132)) prove the logic. This checklist proves the real players and a real tunnel behave the way those suites assume. It extends [`m1b-real-youtube.md`](m1b-real-youtube.md), which still covers YouTube. Owner: QA ([OME-133](/OME/issues/OME-133)).

## How to run

```sh
bunx playwright install chromium                      # once
bun run e2e:real                                      # all real specs: YouTube (M1b) + Twitch/Vimeo; the tunnel spec skips without a tunnel
bunx playwright test --project=e2e-real real-providers   # Twitch + Vimeo only (about 3 min)
```

- Specs: `e2e/real/real-providers.real.ts` and `e2e/real/real-tunnel.real.ts`, with helpers in `e2e/real/providers.ts` and `e2e/real/real.ts`. They run headed on the real network (on Xvfb by default, see `docs/qa/headed-on-xvfb.md`), use the **dev** web build (they read `window.__omega.room.playback()`), and never run in CI.
- Evidence goes to `e2e/real/results/m2-<item>.json` and `.png` (git-ignored). Attach it to the sign-off issue.
- The spec reads the real `<video>` inside each provider's cross-origin player iframe (`currentTime`, `paused`, `playbackRate`, Twitch's ad label, overlay text). It never changes what the site does.
- Twitch VODs expire and channels go on and off air, so pick fresh ids on twitch.tv when a default stops working:

  | Env | Default | Needs to be |
  |---|---|---|
  | `OMEGA_REAL_TWITCH_VOD` | `2784566594` (an upload on `twitch`; uploads don't expire) | a public VOD |
  | `OMEGA_REAL_TWITCH_LIVE` | `valorant` | **live now**, not mature |
  | `OMEGA_REAL_TWITCH_MATURE` | `ironmouse` | live now, "Mature" tag |
  | `OMEGA_REAL_TWITCH_OFFLINE` | `twitchdev` | exists, not live |
  | `OMEGA_REAL_VIMEO` | `1084537` (Big Buck Bunny, 597 s) | public, ≥ 6 min |
  | `OMEGA_REAL_VIMEO_GONE` | `999999999999` | `player.vimeo.com/video/<id>/config` answers 404 |
  | `OMEGA_REAL_VIMEO_REFUSED` | unset (item not run) | domain-restricted ("embed on specific domains") |

### The tunnel spec

It needs a running tunnel in front of a tunnel-mode server. It won't start one itself: that is an operator step (see `docs/ops/tunnel.md`). Use port 8807, so the dev server the other specs use keeps 8787:

```sh
bun run --filter @omega/web build && bun run --filter @omega/extension build:e2e
ngrok http 127.0.0.1:8807 --url https://<name>.ngrok-free.app       # or, no account: cloudflared tunnel --url http://127.0.0.1:8807
PUBLIC_ORIGIN=https://<host> TRUST_PROXY=loopback HOST=127.0.0.1 PORT=8807 STATIC_DIR=$PWD/apps/web/dist bun apps/server/src/index.ts
OMEGA_REAL_TUNNEL_ORIGIN=https://<host> OMEGA_REAL_TUNNEL_PORT=8807 bunx playwright test --project=e2e-real real-tunnel
```

Stop the tunnel afterwards. Don't paste the tunnel host into issues while it is up.

On ngrok (free plan, one session at a time: claim it on the Coordination doc first), the spec handles the interstitial itself. Browsers that aren't under test get `ngrok-skip-browser-warning` through a route on the tunnel origin only. A context-wide `extraHTTPHeaders` would also reach YouTube, and its player then won't start. The extension's browser gets no help: it sees the warning page, clicks *Visit Site*, and T2 then reads ngrok's local inspector (`OMEGA_REAL_NGROK_API`, default `http://127.0.0.1:4040`) to check that the popup's own requests carried the header. Don't clear the *Visit Site* cookie to test this: the room page's lazy chunks (`youtube-*.js`, `twitch-*.js`) then get the warning page instead of JavaScript.

## Checklist

"2 browsers" means two Chromium processes with their own profiles on one machine. Spread is the offset between the two real `<video>` clocks, with each sample moved to the other's time. Budget: ≤ 500 ms (`docs/perf-budgets.md`, Sync row).

| # | Check | Pass when |
|---|---|---|
| P1 | **Twitch VOD**, 2 browsers: steady, pause, play, and seek to 300 s from browser 1. Records any pre-roll ad and what the room did during it. | Spread ≤ 500 ms steady, after play and after the seek. Both pause, ≤ 500 ms apart. 10 s after the seek both are within 1 s of the room clock. `seekOnly` is true (Twitch has no rate). |
| P2 | **Vimeo**, the same steps | Same as P1. Record whether the rate probe held (`seekOnly`). |
| P3 | **Twitch live**, 2 browsers: pause, then play-from-live, from browser 1 | `live` is true, the LIVE pill shows and the scrubber is hidden. Both real players pause and resume. Arrival spread is recorded: the live budget is still open (board B1). Only a < 2 s sanity bound is asserted. |
| P4 | **Refused / gone / offline / gated**: Vimeo not-found, Twitch VOD `1`, a Twitch login that doesn't exist, an offline channel, a mature channel, and optionally a domain-restricted Vimeo | Any embed that doesn't play has a **site** notice saying why, and the transport is frozen (`canControl` false). One that plays needs no notice. |
| T1 | **Tunnel**: the site, API and WebSocket on the public https origin. Two browsers join and chat. | `/healthz` answers 200 through the tunnel. The page is https, the chat arrives, and there's no `http:` subresource. |
| T2 | **Tunnel + extension**: the extension's server URL set to the tunnel. Share from the popup, and a second browser watches. Then a Twitch VOD. | The popup's server status is hidden, and the share reports `ok`. The YouTube `origin` is the tunnel origin. Spread ≤ 500 ms, and both pause. Twitch `parent` equals the tunnel host and it plays, with spread ≤ 500 ms. |
| T3 | **Foreign Origin / Host** | A stolen token from a foreign `Origin` gets 403. A share from a real foreign page (`https://example.com`) is blocked, and its WebSocket doesn't open. A foreign `Host` on the loopback listener gets 421. The room is unchanged. A token holder with no `Origin` may share (by design, ADR 0015). |
| T4 | **X-Forwarded-For through the real tunnel**: 30 unauthorized shares, each with a new spoofed XFF | The first 20 get 401, then 429: the tunnel appends the real address, so spoofing doesn't give fresh buckets. |
| T5 | **ngrok only**: the free-plan interstitial for a first-time visitor, and the extension's `ngrok-skip-browser-warning` | Without the header, a browser User-Agent gets `ERR_NGROK_6024` (the warning page), and with it the app. A fresh profile sees the interstitial once, and *Visit Site* reaches the room and joins. The popup's `GET /rooms` and share carry the header (T2, ngrok's inspector). |
| Y1 | **YouTube pre-roll** (M1b item 1): 10 monetized candidates in the room, then the same ids as a raw `www.youtube.com` embed (the control) | The room stays playing through an ad, and the spread is < 1 s 6 s after it. If there's no ad in the room or in the control, it's a **known gap**, and the fake player's `ad(ms)` (`e2e/sync.e2e.ts`) is the only coverage. |

Not automated: two *machines*. Everything here runs on one host. Rerun T1 and T2 from a second machine when there is one.

## Results

Newest first.

### 2026-09-30 · `main` @ 7ef254c (tunnel, P4) and @ 49795e9 (P1–P3, Y1) · Chrome for Testing (Playwright 1.63.0), headed, Linux/Wayland · logged-out profiles · QA ([OME-133](/OME/issues/OME-133))

Both tunnels were run: the **cloudflared** quick tunnel (the no-account fallback) at 49795e9, then **ngrok** (free plan, the fixed `*.ngrok-free.dev` dev domain) at 7ef254c. P4 was rerun at 7ef254c, after [OME-176](/OME/issues/OME-176).

| # | Result | Evidence |
|---|---|---|
| P1 | **PASS.** `2784566594`: steady worst 286 ms (first sample, then ≤ 50 ms), both paused on the same frame (0 ms), 1 ms after play, 3 ms after the seek, and −76/−79 ms against the room clock 10 s after it. `seekOnly: true`. No pre-roll served. | `m2-twitch-vod.json`, `m2-twitch-vod-{1,2}.png` |
| P2 | **PASS.** `1084537`: 124 / 0 / 16 / 26 ms, and +97/+107 ms against the room clock. The rate probe held on this free-account video (`seekOnly: false`). | `m2-vimeo.json`, `m2-vimeo-{1,2}.png` |
| P3 | **PASS.** `valorant`: LIVE pill, no scrubber. The pause arrived at 193/250 ms (57 ms spread), play-from-live at 419/157 ms (262 ms). No pre-roll served. In an earlier run: 68 and 59 ms. | `m2-twitch-live.json`, `.png` |
| P4 | **PASS, with notes.** Vimeo not-found: "…it's unavailable (removed or private).", frozen (`not-found` / `NotFoundError`, fixed by [OME-176](/OME/issues/OME-176)). Twitch offline `twitchdev`: "…the channel is offline.", frozen. Twitch VOD `1` and the login that doesn't exist: "…the player didn't start." (Twitch sends no error, so the ready timeout fires), frozen. **Mature gate: not observed.** `ironmouse` was live with the Mature tag, but the embed played ungated for this logged-out viewer, so no notice was needed. **Vimeo domain-restricted: not run** (no known public id). | `m2-refused.json`, `m2-refused-*.png` |
| Y1 | **Known gap: no ad served.** 0 of 10 monetized candidates in the room (nocookie) and 0 of 10 on the `www.youtube.com` control embed, two runs each. Candidates: `dQw4w9WgXcQ`, `kJQP7kiw5Fk`, `JGwWNGJdvx8`, `OPf0YbXqDm0`, `09R8_2nJtjg`, `fRh_vgS2dFE`, `fJ9rUzIMcZQ`, `RgKAFK5djSk`, `CevxZvSJLk8`, `hT_nvWreIhg`. Every one played ad-free on both hosts, so this profile/IP gets no embed pre-rolls at all (it's not the nocookie host). The room stayed playing throughout. Coverage is still the fake `ad(ms)` in `e2e/sync.e2e.ts`. Twitch served no pre-roll either (P1, P3). | `01-ads.json` |

| # | cloudflared | ngrok | Evidence |
|---|---|---|---|
| T1 | **PASS.** `/healthz` 200 via Cloudflare. The room is on https, the chat went A → B, and there's no mixed content. | **PASS.** The same: `/healthz` 200, https, chat A → B, no mixed content. | `m2-tunnel-1.json` |
| T2 | **PASS.** The popup shared through the tunnel (`ok`). YouTube `origin` = the tunnel origin: steady 69 ms, pause 0 ms, 4 ms after play. Twitch `parent` = the tunnel host, it played, and the spread was 110 ms. | **PASS.** The extension's browser got the interstitial and clicked through. The popup's `GET /rooms` and share both carried `ngrok-skip-browser-warning`, and the share was `ok`. YouTube `origin` = the tunnel origin: steady 17 ms, pause 0 ms, 9 ms after play. Twitch `parent` = the tunnel host, it played, 87 ms. | `m2-tunnel-2.json`, `m2-tunnel-2-{ext,viewer}.png`, `m2-tunnel-interstitial-tunnel-ext.png` |
| T3 | **PASS.** A stolen token from a foreign Origin got 403. From `https://example.com`, the fetch was blocked and the WebSocket errored. Host `evil.example` got 421 and the public host 200. The room was unchanged. The no-Origin control got 200 (by design). | **PASS.** The same results. ngrok's inspector shows that every `Origin: https://example.com` request (two shares and the WebSocket upgrade) reached the server and got **403 from it**, not from ngrok's warning page. | `m2-tunnel-3.json`, `m2-tunnel-3-ngrok-log.json` |
| T4 | **PASS.** 20 × 401, then 10 × 429. A spoofed XFF is ignored. | **PASS.** 20 × 401, then 10 × 429. ngrok appends the real client too, so `TRUST_PROXY=loopback` holds (`docs/ops/tunnel.md`). | `m2-tunnel-4.json` |
| T5 | n/a (cloudflared shows no interstitial) | **PASS.** A browser User-Agent with no header got `ERR_NGROK_6024` (the warning page), and with the header it got the app. A fresh profile saw the interstitial on its first visit. *Visit Site* reached the room and joined (share token issued). No interstitial on the second visit. | `m2-tunnel-5.json`, `m2-tunnel-interstitial-tunnel-fresh.png`, `m2-tunnel-5-after-visit.png` |

Edge case seen while writing T2 (not a product bug): ngrok's *Visit Site* pass is a cookie. If it expires or is cleared mid-session, the next lazily loaded chunk (the Twitch or YouTube adapter on the next share) gets the warning page's HTML, and that player won't start until the page is reloaded. Only free-plan ngrok sessions are affected.

The M1b YouTube checklist was rerun in the same session with the share-token fix to `e2e/real/real.ts`: 7 pass and item 1 is skipped (no ad), in line with the last M1b run.
