# M2 real-world sign-off: Twitch, Vimeo, a public tunnel, YouTube pre-roll (QA; rerun at each milestone)

CI never touches the real providers or a real tunnel. The fake-SDK suites (`e2e/provider-sync.e2e.ts`, `e2e/vimeo.e2e.ts`) and the local-proxy tunnel suite (`e2e/tunnel*.e2e.ts`, [OME-132](/OME/issues/OME-132)) prove the logic. This checklist proves the real players and a real tunnel behave the way those suites assume. It extends [`m1b-real-youtube.md`](m1b-real-youtube.md), which still covers YouTube. Owner: QA ([OME-133](/OME/issues/OME-133)).

## How to run

```sh
bunx playwright install chromium                      # once
bun run e2e:real                                      # all real specs: YouTube (M1b) + Twitch/Vimeo; the tunnel spec skips without a tunnel
bunx playwright test --project=e2e-real real-providers   # Twitch + Vimeo only (about 3 min)
```

- Specs: `e2e/real/real-providers.real.ts` and `e2e/real/real-tunnel.real.ts`, with helpers in `e2e/real/providers.ts` and `e2e/real/real.ts`. They run headed on the real network, use the **dev** web build (they read `window.__omega.room.playback()`), and never run in CI.
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
| T5 | **ngrok only**: the free-plan interstitial for a first-time visitor, and the extension's `ngrok-skip-browser-warning` | By hand in a fresh profile: the interstitial shows once, *Visit Site* reaches the room, and the popup shares without seeing it. |
| Y1 | **YouTube pre-roll** (M1b item 1): 10 monetized candidates in the room, then the same ids as a raw `www.youtube.com` embed (the control) | The room stays playing through an ad, and the spread is < 1 s 6 s after it. If there's no ad in the room or in the control, it's a **known gap**, and the fake player's `ad(ms)` (`e2e/sync.e2e.ts`) is the only coverage. |

Not automated: two *machines*. Everything here runs on one host. Rerun T1 and T2 from a second machine when there is one.

## Results

Newest first.

### 2026-09-30 · `main` @ 49795e9 · Chrome for Testing (Playwright 1.63.0), headed, Linux/Wayland · logged-out profiles · QA ([OME-133](/OME/issues/OME-133))

Tunnel: the **cloudflared** quick tunnel (the no-account fallback), because ngrok isn't installed on this host and there's no `ngrok_authtoken` yet ([OME-174](/OME/issues/OME-174)).

| # | Result | Evidence |
|---|---|---|
| P1 | **PASS.** `2784566594`: steady worst 286 ms (first sample, then ≤ 50 ms), both paused on the same frame (0 ms), 1 ms after play, 3 ms after the seek, and −76/−79 ms against the room clock 10 s after it. `seekOnly: true`. No pre-roll served. | `m2-twitch-vod.json`, `m2-twitch-vod-{1,2}.png` |
| P2 | **PASS.** `1084537`: 124 / 0 / 16 / 26 ms, and +97/+107 ms against the room clock. The rate probe held on this free-account video (`seekOnly: false`). | `m2-vimeo.json`, `m2-vimeo-{1,2}.png` |
| P3 | **PASS.** `valorant`: LIVE pill, no scrubber. The pause arrived at 193/250 ms (57 ms spread), play-from-live at 419/157 ms (262 ms). No pre-roll served. In an earlier run: 68 and 59 ms. | `m2-twitch-live.json`, `.png` |
| P4 | **PASS, with notes.** Twitch offline `twitchdev`: "…the channel is offline.", frozen. Twitch VOD `1` and the login that doesn't exist: "…the player didn't start." (Twitch sends no error, so the ready timeout fires), frozen. Vimeo not-found: "…the player reported an error (code NotFoundError).", frozen, but `NotFoundError` should read "unavailable (removed or private)" ([OME-176](/OME/issues/OME-176)). **Mature gate: not observed.** `ironmouse` was live with the Mature tag, but the embed played ungated for this logged-out viewer, so no notice was needed. **Vimeo domain-restricted: not run** (no known public id). | `m2-refused.json`, `m2-refused-*.png` |
| T1 | **PASS.** `/healthz` 200 via Cloudflare. The room is on https, the chat went A → B, and there's no mixed content. | `m2-tunnel-1.json` |
| T2 | **PASS.** The popup shared through the tunnel (`ok`). YouTube `origin` = the tunnel origin: steady 69 ms, pause 0 ms, 4 ms after play. Twitch `parent` = the tunnel host, it played, and the spread was 110 ms. | `m2-tunnel-2.json`, `m2-tunnel-2-{ext,viewer}.png` |
| T3 | **PASS.** A stolen token from a foreign Origin got 403. From `https://example.com`, the fetch was blocked and the WebSocket errored. Host `evil.example` got 421 and the public host 200. The room was unchanged. The no-Origin control got 200 (by design). | `m2-tunnel-3.json` |
| T4 | **PASS (cloudflared).** 20 × 401, then 10 × 429. cloudflared appends the real client, so a spoofed XFF is ignored. **Still to confirm on ngrok** (`docs/ops/tunnel.md` assumption). | `m2-tunnel-4.json` |
| T5 | **NOT RUN.** ngrok isn't available ([OME-174](/OME/issues/OME-174)). cloudflared shows no interstitial. | n/a |
| Y1 | **Known gap: no ad served.** 0 of 10 monetized candidates in the room (nocookie) and 0 of 10 on the `www.youtube.com` control embed, two runs each. Candidates: `dQw4w9WgXcQ`, `kJQP7kiw5Fk`, `JGwWNGJdvx8`, `OPf0YbXqDm0`, `09R8_2nJtjg`, `fRh_vgS2dFE`, `fJ9rUzIMcZQ`, `RgKAFK5djSk`, `CevxZvSJLk8`, `hT_nvWreIhg`. Every one played ad-free on both hosts, so this profile/IP gets no embed pre-rolls at all (it's not the nocookie host). The room stayed playing throughout. Coverage is still the fake `ad(ms)` in `e2e/sync.e2e.ts`. Twitch served no pre-roll either (P1, P3). | `01-ads.json` |

The M1b YouTube checklist was rerun in the same session with the share-token fix to `e2e/real/real.ts`: 7 pass and item 1 is skipped (no ad), in line with the last M1b run.
