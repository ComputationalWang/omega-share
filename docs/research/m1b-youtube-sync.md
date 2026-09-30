# M1b research: YouTube IFrame sync, clock offset, iframe safety, test strategy

[OME-75](/OME/issues/OME-75) · 2026-09-30 · Lead Engineer · research only. Nothing here changes code or `packages/shared`.

This doc builds on ADR 0002 (the server-authoritative sync model) and ADR 0003 (wire contract v0; playback was left out of v0). Budgets are from `docs/perf-budgets.md`: sync spread ≤ 500 ms, relay ≤ 50 ms, p95 frame ≤ 16.7 ms with video playing, initial JS ≤ 200 KB gzip.

**Evidence labels.** **[doc]** is an official doc page. **[code]** is YouTube's served script. **[spike]** is a measurement from our throwaway spike (see §5; branch `scratch/OME-75-perf-spike`, local only, not merged). **[inferred]** is reasoning that has not been verified yet.

## TL;DR: the recommended approach

1. **Player.** `tvFrame()` stays the only thing that builds the iframe. It adds `enablejsapi=1&origin=<site origin>&controls=0&disablekb=1`. We then attach the **official IFrame API** to that element with `new YT.Player(iframe)`. We don't implement the undocumented postMessage protocol ourselves.
   - The API script is loaded lazily, only once the room has an embed.
   - It costs 12.4 KB compressed on the network [spike]. It is not part of our bundle.
2. **Sync.** A small `PlayerAdapter` interface sits between a pure `decide()` function and the real YouTube player. The sync loop runs at 4 Hz on a timer, not per frame.
   - Explicit actions (play/pause/seek, join, embed change) → **hard seek**.
   - Slow drift → dead band 100 ms, rate nudge from 100 ms to 1 s, seek above 1 s.
   - `setPlaybackRate(1.05)` is accepted [spike], but whether it is really applied must be checked. There is a fallback ladder if it isn't.
3. **Clock.** An app-level NTP-style `ping`/`pong` over the existing WebSocket. Timestamps come from `performance.timeOrigin + performance.now()` on the client and `Date.now()` on the server.
   - At connect: a burst of 5 pings, 200 ms apart. After that, one ping every 15 s, and again on `visibilitychange`.
   - Use the minimum-RTT sample from a sliding window of 8.
   - Target offset error: ≤ 25 ms.
4. **Safety.**
   - CSP gets a *path-scoped* script source: `https://www.youtube.com/iframe_api https://www.youtube.com/s/player/`.
   - `frame-src` adds `https://www.youtube-nocookie.com`. The iframe host becomes nocookie once it's confirmed working with the API.
   - Sandbox gains `allow-popups allow-popups-to-escape-sandbox` so YouTube's own links open in a new tab. It still has no top-navigation and no forms.
   - Nothing of ours may overlap the player rectangle. The player must be at least 200×200 px (YouTube's Required Minimum Functionality rules, "RMF" below). **The TV is 320×180 today, which is too small.** See §3.4.
5. **Tests.** Playwright already stubs every non-localhost request. For e2e we'll serve a **fake `iframe_api`** at the real URL with a deterministic media clock and hooks to inject buffering or ads.
   - That way the production bundle is exactly what ships, and the real adapter code runs under test.
   - The only checks that need real YouTube (ads, embedding-disabled videos, autoplay with sound, nocookie, the real effective rate) go in a manual/nightly checklist.

## 1. YouTube IFrame Player API

Sources:
- API reference: <https://developers.google.com/youtube/iframe_api_reference>
- Player parameters: <https://developers.google.com/youtube/player_parameters>
- Served widget script: `https://www.youtube.com/s/player/57bae81f/www-widgetapi.vflset/www-widgetapi.js`

### 1.1 What we use

| Need | API | Notes |
|---|---|---|
| Ready | `onReady` | We must not send commands before it fires. |
| State | `onStateChange` | Values: -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued [doc]. |
| Rate | `onPlaybackRateChange`, `getPlaybackRate`, `setPlaybackRate`, `getAvailablePlaybackRates` | See 1.3. |
| Errors | `onError` | 2 bad parameter, 5 HTML5 error, 100 not found, 101/150 embedding disallowed, 153 missing Referer / client identity [doc]. |
| Autoplay | `onAutoplayBlocked` | "fires any time the browser blocks autoplay or scripted video playback" [doc]. |
| Control | `playVideo`, `pauseVideo`, `seekTo(s, true)` | `allowSeekAhead=true` for real seeks. |
| Time | `getCurrentTime`, `getDuration` | See 1.2. |
| Local volume | `mute`, `unMute`, `setVolume` | Volume is per-user (ADR 0002). |

### 1.2 How accurate `getCurrentTime` is

- **It's synchronous and extrapolated [code].** It reads a cached value and, while playing, adds the time since the last update (`(Date.now()/1E3 - currentTimeLastUpdated_) * playbackRate`, capped at +1 s).
- **Update cadence [spike].** The iframe pushes `infoDelivery` messages about every **265 ms** (257–275 ms).
  - Between those pushes, the value moves on every animation frame (median step 17 ms), because it's interpolated.
  - Separately, the widget script polls the iframe with a "listening" message every 250 ms (`yt_embedsWidgetPollIntervalMs || 250`) [code].
- **Consequences.**
  - While playing smoothly, the error is small. Extrapolation only goes wrong when the player stalls between two pushes, so the worst case is about 265 ms of phantom progress during a stall.
  - So `decide()` only trusts a drift sample when the player state is `playing` and has been for ≥ 500 ms. It also smooths drift over the last 3 samples (a median) before acting.
  - The cache is extrapolated with `Date.now()`, but our sync clock is `performance.now()`. The two can drift if the wall clock slews. This only matters at the millisecond scale.

### 1.3 Playback rate: can we nudge?

- **Doc:** `setPlaybackRate` "sets the suggested playback rate". If the value isn't supported, the player "will round that value down to the nearest supported value in the direction of 1". `cueVideoById`/`loadVideoById` reset the rate to 1.
- **Spike:** `getAvailablePlaybackRates()` → `[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]`. But `setPlaybackRate(1.05)` then `getPlaybackRate()` → **1.05**, so the fine rate was accepted and reported back.
  - We have **not** verified that the media element really plays at 1.05. The report could just echo our own call.
- **Plan: feature-detect, then fall back.**
  1. Nudge with `rate = 1 ± min(0.1, |drift| / 5 s)`, and hold it until drift is inside the dead band. A 1 s drift then closes in about 10 s.
  2. **Effective-rate check:** during a nudge, measure the slope of `getCurrentTime()` over 2 s. If the slope stays within 0.01 of 1.0, fine rates aren't really applied. In that case, switch to short bursts at 0.75 or 1.25 from the available list.
  3. If rate changes are rejected completely (a live stream, or `getAvailablePlaybackRates()` returns `[1]`), use seek-only mode with a 500 ms seek threshold.
- **User-visible:** a 10% change is audible on music. Syncplay slows down only, at 0.95 (`SLOWDOWN_RATE`, <https://github.com/Syncplay/syncplay/blob/master/syncplay/constants.py>). Jellyfin uses `1 + diff/1000 ms` for 1 s (`PlaybackCore.js`). Our cap of ±10% sits between those two.

### 1.4 Ads and buffering

- **Buffering** is state 3 [doc]. The room never waits for it (ADR 0002). While the local player is buffering, `decide()` makes no corrections, the same as Jellyfin's `isBuffering()` guard. When the player returns to 1 (playing), it catches up with a seek or a nudge.
- **Ads** aren't documented in the API reference [inferred]. They play inside the same player, and state and time follow the ad, not the content. So:
  - We never *derive room intents* from player events unless we can explain them (see §1.5). An ad's pause or play must not pause the room.
  - We treat "`getDuration()` differs from the content's duration seen at `onReady`" or "`getVideoData().video_id !== embed.videoId`" as *in an ad* [inferred]: no corrections, no intents.
  - This is a manual check in §4.3. Ads don't appear in CI.

### 1.5 Where user intent comes from

- With `controls=0` and `disablekb=1` [doc: player parameters], YouTube shows no scrubber or play button, and keyboard shortcuts are off. **Play, pause and seek come from our own control bar outside the player.** That makes them explicit, testable intents.
- The only remaining player-originated action is a click on the video, which toggles play/pause [inferred].
  - The adapter tracks the *expected* state after each of our commands.
  - A `paused` or `playing` event that doesn't match, isn't buffering or ad-related, and arrives outside a 1 s echo window after our own command becomes a room `control` intent.
- The API's own loader normally creates the iframe. We attach to our element instead (documented: an existing iframe with `enablejsapi=1` and `origin` [doc]). That way sandbox, allow and src are still decided in `tvFrame()`.

## 2. Clock sync over the existing WebSocket

### 2.1 Why app-level

- Browser JS can't see WebSocket ping/pong frames. The WHATWG spec says they "are not currently exposed in the API" (<https://websockets.spec.whatwg.org/>).
- Bun's `sendPings` and `idleTimeout` (<https://bun.sh/docs/api/websockets>) keep the socket alive, but they don't give us timestamps.
- So we add a `ping` message.

### 2.2 The algorithm (Cristian/NTP, RFC 5905 §8 simplified)

The client stamps `t0` when it sends `ping{id}`. The server replies `pong{id, at}` straight away, where `at = Date.now()`. Receive and send happen in the same handler, so t1 ≈ t2. The client stamps `t3` on receive.

```
rtt    = t3 − t0
offset = at − (t0 + t3) / 2        // server_ms ≈ client_ms + offset
error  ≤ rtt / 2                   // tighter on a symmetric path
```

- **Client clock:** `performance.timeOrigin + performance.now()`. It's monotonic and not affected by NTP steps. Browsers coarsen it to 100 µs, or 5 µs when cross-origin isolated (<https://w3c.github.io/hr-time/>), which is negligible here.
  - The monotonic clock may pause while the OS sleeps, so we resync on `visibilitychange`, on `online`, and after a gap of more than 2 s between sync-loop ticks.
- **Server clock:** `Date.now()`, already used for `chat.at`.
- **Sampling:**
  - A burst of 5 pings, 200 ms apart, at connect. The server answers pings before `join`, so the offset is ready by the time the snapshot arrives.
  - After that, one ping every 15 s.
  - Keep a window of 8 samples and use the one with the **minimum RTT**. Jellyfin does the same (`TimeSync.js`: `NumberOfTrackedMeasurements = 8`, min-delay selection; 3 greedy pings at 1 s, then one every 60 s).
  - Until the first `pong`, `decide()` stays idle, the same as Jellyfin's `Manager.js` queueing commands until time sync is ready.
- **Rate limit:** the WS bucket is burst 20 and 10 per second per connection (`apps/server/src/server.ts:48-49`). A 5-ping burst at 5/s plus one every 15 s is well inside it.
  - Pings share the bucket with chat on purpose. An exemption would be a flood vector.
  - A client that is rate-limited just keeps its old offset.

### 2.3 How accurate the clock needs to be

Budget: after play/pause/seek, **spread ≤ 500 ms** between any two clients. If every client stays within ±E of the ideal position, then spread ≤ 2E, so **E ≤ 250 ms per client**.

| Error term (per client) | After an explicit action (budgeted) | Steady play | Basis |
|---|---|---|---|
| Clock offset | ≤ 25 ms | ≤ 25 ms | RTT/2; localhost < 1 ms; M2 ngrok tunnel inferred < 50 ms RTT |
| Player time reading | ≤ 30 ms | ≤ 30 ms | [spike] interpolated cadence; stalls filtered by the §1.2 guards |
| Seek landing (seek → playing) | ≤ 150 ms | – | [inferred]: measure in the adapter issue; compensate by seeking to `expected(now + L)`, L = measured seek latency (EWMA) |
| Dead band (no correction) | – (everyone hard-seeks) | ±100 ms | Jellyfin speed-to-sync min 60 ms; Syncplay resets < 0.1 s |
| **Per client E** | **≤ ~205 ms → pairwise ≤ ~410 ms ≤ 500 ms** | ≤ ~155 ms → pairwise ≤ ~310 ms | |

The worst case assumes opposite signs on two clients, which is pessimistic because the terms are independent. The steady state isn't budgeted, but it stays under 500 ms too. Drift between 100 ms and 1 s is nudged away before it can add up.

**Proposed numbers to adopt:**
  - Offset error ≤ 25 ms (reject samples with RTT > 500 ms).
  - Dead band 100 ms.
  - Nudge from 100 ms to 1 s.
  - Seek above 1 s during steady play.
  - Always hard-seek on an explicit action, a join or an embed change.
- **Proposed new perf metric:** `sync.spread` (measured, merge-blocking), i.e. max − min of expected-minus-actual across 8 clients, 2 s after each action. The existing budget row "Spread between clients after play/pause/seek ≤ 500 ms" already covers it. It just needs a measurement.
  - No new budget number is needed. The ≤ 25 ms offset target is an internal design number, not a budget.

## 3. Safety: how the player iframe is created

### 3.1 It still fits "never render arbitrary iframes"

- ADR 0003 says clients may use only a parsed `Embed.url` as an iframe `src`, and `tvFrame()` (`apps/web/src/tv.ts:19-28`) is the only builder.
- That stays the same. `tvFrame()` parses `EmbedSchema`, then derives the src from the canonical URL:
  - It optionally swaps the host to the constant `https://www.youtube-nocookie.com`.
  - It adds fixed query parameters: `enablejsapi=1`, `origin=location.origin`, `controls=0`, `disablekb=1`, `playsinline=1`, `rel=0`, `autoplay=1`.
- The YouTube API only *attaches* to that element. We never call `new YT.Player(div, {videoId})`, because that lets the API choose the src, sandbox and allow list.
- **Contract impact: none for nocookie.** `Embed.url` stays `https://www.youtube.com/embed/<id>` on the wire. The host swap is a rendering detail inside `tvFrame()`. ADR 0003's sentence gets a clarifying note in the new ADR (§6).

### 3.2 sandbox and allow

- **Today:** `sandbox="allow-scripts allow-same-origin allow-presentation"`. This plays [spike: 6/6 runs, no errors].
- **The official API's own default** [code] is `allow-same-origin allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-storage-access-by-user-activation allow-presentation`.
- **Proposal:** add `allow-popups allow-popups-to-escape-sandbox`.
  - Without it, the YouTube logo/title link and ad click-through fail silently. RMF expects the player's links to work [inferred].
  - Popups open in a new browsing context. That context can't navigate our tab, because we still don't grant `allow-top-navigation*`.
  - Still excluded: `allow-forms`, `allow-top-navigation*`, `allow-modals`, `allow-storage-access-by-user-activation`.
  - QA check: our tab's URL never changes after clicking inside the player.
- **`allow`:** keep `autoplay; encrypted-media; picture-in-picture; fullscreen`. The API default also has accelerometer, gyroscope, clipboard-write and web-share, and we don't need any of them.
- **`referrerpolicy="strict-origin-when-cross-origin"`:** keep it. RMF forbids `noreferrer`, and error 153 happens when the Referer is missing [doc].

### 3.3 CSP (`apps/web/index.html:8`)

| Directive | Today | M1b |
|---|---|---|
| `script-src` | `'self'` | `'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/` |
| `frame-src` | `https://www.youtube.com` | `https://www.youtube.com https://www.youtube-nocookie.com` |

- **Why path-scoped.** The API script runs *in our origin*, so it can touch the DOM and the WebSocket. CSP source expressions may carry a path, and a trailing `/` matches the prefix.
  - The loader pulls only `www.youtube.com/s/player/<hash>/www-widgetapi.vflset/www-widgetapi.js` [code, spike].
  - The spike verified the host-level form. The path-scoped form must be verified in the adapter issue. Fallback: `https://www.youtube.com`.
- **Trusted Types.** The loader creates a Trusted Types policy named `youtube-widget-api` [code]. If we ever enforce `require-trusted-types-for`, we'd need to add `trusted-types youtube-widget-api`. We don't enforce it today.
- **Other hosts.** Everything else the spike saw (googlevideo, ytimg, doubleclick, gstatic) was requested *by the iframe*. That's governed by YouTube's CSP, not ours.
- **Supply-chain residual risk.** We now run first-party YouTube code in our origin. That's accepted because the alternative is reimplementing an undocumented protocol, which is brittle. RMF also forbids changes to the player "not explicitly described by the API documentation" [doc]. This goes into the ADR.
- **Loading.** A dynamic `<script src>` is inserted only when the embed is non-null, and only once per page. `window.onYouTubeIframeAPIReady` is wrapped in a promise, and a 10 s timeout drops us to "video without sync" with a notice.

### 3.4 Policy constraints (RMF, <https://developers.google.com/youtube/terms/required-minimum-functionality>)

- **Minimum 200×200 px viewport.** The TV is `320×180` (`apps/web/src/layout.ts:25`), and the stage is CSS-scaled down on narrow windows (`apps/web/src/room.ts:107`). **That fails already at scale 1.**
  - Fix in the M1b layout issue: make the TV at least 356×200 CSS px *after* scaling. Either enlarge it and move it out of the scaled stage, or clamp the scale.
  - Tell the designer. This interacts with the room art.
- **No overlays in front of any part of the player.** The `overlay`, `tags` and `bubbles` layers are appended after the TV (`apps/web/src/room.ts:103`), so they stack above it.
  - Add a layout unit test: bubble, tag and control-bar rects never intersect the TV rect, including for the back-row seats.
- **Autoplay** only when the player is visible, more than 50% on screen, and it's the only autoplaying player on the page. The TV is always in view in the room, so this holds.
  - The "Enter room" click gives user activation. The iframe has `allow="autoplay"`, so the delegation is there. Whether sound plays gets checked manually.
  - On `onAutoplayBlocked`: `mute()` + `playVideo()`, then show an "Unmute" button outside the player.
- **"No mouseover or touch events on the player to initiate any action."** The control bar lives outside the player, so this is satisfied.
- **Open policy question** [inferred]: RMF doesn't say whether one user may control playback for others. ADR 0002 already decided shared control. Flagged for the board. There's no engineering impact.

## 4. Testability

### 4.1 Seams

```ts
// apps/web: one interface, two implementations (real YT, fake in unit tests)
interface PlayerAdapter {
  play(): void; pause(): void; seek(seconds: number): void;
  setRate(rate: number): void;
  time(): number;                 // seconds, as the player reports it
  state(): PlayerState;           // "unstarted" | "playing" | "paused" | "buffering" | "ended" | "cued" | "ad"
  rates(): readonly number[];
  onEvent(cb: (e: PlayerEvent) => void): () => void;  // state change, error, autoplay-blocked
  destroy(): void;
}

// Pure. No clock, no DOM. Table-tested with bun test.
function decide(input: {
  room: PlaybackState; offsetMs: number; nowMs: number;
  playerTime: number; playerState: PlayerState; stableForMs: number; lastRate: number;
}): Correction;   // { kind: "none" } | { kind: "seek", to } | { kind: "rate", rate } | { kind: "play" } | { kind: "pause" }
```

- The sync loop is a `setInterval(250)` that calls `decide()` and applies the result.
- It allocates nothing per tick in steady state: it reuses a preallocated input object and returns constant `Correction`s for `none`/`play`/`pause`.
- It's kept separate from the PixiJS ticker, so the frame budget doesn't depend on it.

### 4.2 Test layers

1. **Unit tests (`bun test`, CI):**
   - `decide()` tables: dead band, nudge sign and magnitude, seek threshold, buffering/ad guards, the effective-rate fallback.
   - Clock estimator: min-RTT selection, rejecting RTT > 500 ms, resetting after a sleep gap.
   - Server playback reducer: last-write-wins, extrapolating position on pause/play, clamping, rejecting a stale `videoId`, resetting on an embed change.
   - Contract schemas.
2. **Server integration (`bun test`, real `Bun.serve`):**
   - `ping` → `pong` before and after `join`.
   - `control` → `playback` broadcast to every room member within the 50 ms relay budget. Extend `apps/server/src/relay-latency.ts`.
   - The control rate limiter.
3. **Deterministic e2e (Playwright, CI, offline):**
   - Extend `e2e/support/network.ts` so `https://www.youtube.com/iframe_api` serves `e2e/fixtures/fake-iframe-api.js`, and `https://www.youtube.com/embed/*` (plus the nocookie host) serves a blank fixture page.
   - The fake `YT.Player(iframe)` implements the API subset from §1.1 with a media clock (`performance.now()`-driven, honours `setPlaybackRate`, emits state events). It exposes `window.__fakeYt` so specs can inject `buffering(ms)`, `ad(ms)`, `autoplayBlocked()`, `error(150)` and a seek latency.
   - The production bundle is unchanged. The *real* adapter and loader run, and only YouTube is replaced.
   - We don't use `page.clock`, because faking time would also freeze rAF and PixiJS.
   - Specs, 8 contexts via `joinRoom`:
     - Play, pause and seek each give spread ≤ 500 ms 2 s later.
     - A late joiner lands within 500 ms.
     - A user who buffers for 3 s doesn't pause the room and catches up.
     - An ad on one client doesn't pause the room.
     - A click-pause inside the player becomes a room pause.
     - Every `sandbox`/`allow`/`src` value matches the canonical form.
     - The CSP blocks a non-allowlisted script.
   - Optional: a WS delay proxy in the fixture server for asymmetric latency. Nice to have, not required for M1b.
4. **Perf (`bun run perf`):** `site.frameP95` shares a video and plays it with the fake player. That removes the "no video playing (M1b)" note in `perf/site.perf.ts:61`. Add the `sync.spread` metric (§2.3).

### 4.3 Stays manual or real-network (QA checklist at M1b sign-off; could run nightly with network)

Check each of these against real YouTube:
1. A pre-roll ad on a monetized video: the room doesn't pause, and the client catches up after the ad.
2. Embedding-disabled (101/150) and age-restricted videos show a clear notice.
3. Sound plays after clicking "Enter room" in regular Chrome (not headless). Muted fallback plus the Unmute button work.
4. The nocookie host works with the API attached.
5. **The effective rate at 1.05:** the slope of `getCurrentTime()` over 30 s, and the `video.playbackRate` inside the iframe via DevTools.
6. Buffering under a DevTools "Slow 4G" throttle.
7. Two real browsers on two machines. After M2, over the ngrok tunnel.
8. The path-scoped CSP loads the current `www-widgetapi.js` hash.

## 5. Perf spike (scratch worktree, not merged)

- Headless Chromium, real network, 8 clients in the room, observer = client 0, median of 3 runs. Branch `scratch/OME-75-perf-spike` (local, commit `4490ed1`), scripts `perf/spike.ts`, `perf/tti.ts`, `perf/csp.ts`.
- A = no video, B = plain iframe playing, C = iframe + IFrame API.

| | A | B | C |
|---|---|---|---|
| Initial JS (gzip) | 4.99 KB (the room chunk is 78 KB gzip, lazy) | same | same |
| TTI (landing) | 20 ms | n/a (the video comes after join) | n/a |
| Frame p95 (vsync-snapped, ADR 0009) | 16.67 ms | 16.67 ms | 16.67 ms |
| Raw p95 / missed vsyncs | 16.8 ms / 0 of 300 | 16.7 ms / 0 of 300 | 16.8 ms / 0 of 300 |
| Long tasks on the top page | none | none | none |
| Top-page JS heap after GC | 3.9 MB | 4.0 MB | 4.5 MB |
| API scripts (network, compressed) | – | – | 3.2 KB `iframe_api` + 9.2 KB `www-widgetapi.js` |

**Conclusion:** the iframe and the API are effectively free on the top page. Decoding happens out-of-process, and the API adds about 0.5 MB of heap and no long tasks. The initial JS budget is unaffected, because the API isn't bundled and loads after join.

**Caveats:**
- Headless with no GPU and a fixed 60 Hz begin-frame clock. Video decode CPU and A/V smoothness weren't measured.
- Only the observer page ran the API.
- Unmuted autoplay needed `--autoplay-policy=no-user-gesture-required`.

## 6. Proposed wire-contract delta (draft for the M1b contract issue; not applied)

All additions are backward-compatible. Client→server stays strict, but new clients only talk to new servers. Server→client strips unknown keys (ADR 0003).

```ts
// constants.ts
export const MAX_POSITION_S = 12 * 60 * 60;       // longest seekable position we accept
export const PING_ID_MAX = 2 ** 31 - 1;

// playback.ts (new)
export const PositionSchema = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(MAX_POSITION_S));
export const PLAYBACK_ACTIONS = ["play", "pause", "seek", "load"] as const;   // "load" = new embed
export const PlaybackStateSchema = v.object({
  playing: v.boolean(),
  position: PositionSchema,                        // seconds at `at`
  rate: v.pipe(v.number(), v.minValue(0.25), v.maxValue(2)),  // server always sends 1 in M1b; a range now so shared rate later doesn't break old clients
  at: v.pipe(v.number(), v.integer(), v.minValue(0)),   // server ms since epoch when `position` was true
  rev: v.pipe(v.number(), v.integer(), v.minValue(0)),  // +1 per accepted change; clients drop older revs
  action: v.picklist(PLAYBACK_ACTIONS),
  by: v.nullable(MemberIdSchema),                  // null = from POST /share (load)
});

// ClientMessageSchema additions (strict)
v.strictObject({ type: v.literal("ping"), id: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(PING_ID_MAX)) }),
/** Desired room state. Seek while playing = { playing: true, position }. `videoId` must match the current embed, else ignored. */
v.strictObject({ type: v.literal("control"), videoId: YoutubeVideoIdSchema, playing: v.boolean(), position: PositionSchema }),

// ServerMessageSchema additions (strip)
v.object({ type: v.literal("pong"), id: /* same */, at: /* server ms */ }),
v.object({ type: v.literal("playback"), playback: PlaybackStateSchema }),

// Changed shapes (additive)
RoomStateSchema.playback: v.nullable(PlaybackStateSchema)          // null iff embed null
"embed-changed" gains playback: v.nullable(PlaybackStateSchema)    // { playing: true, position: 0, action: "load" }
ERROR_CODES += "no_embed"                                           // control with no/other embed
```

**Semantics (server):**
- `ping` is allowed before `join` and answered with `ws.send`, not published to the room.
- `control` requires `join`. It also has its own per-connection limit of 4/s on top of the bucket, so seek wars stay bounded.
- The server applies `control` as `{playing, position, at: Date.now(), rev: rev+1, action, by}`, where `action` is derived as follows:
  - `seek` if `position` differs from the extrapolated current position by more than 1 s.
  - Otherwise `play` or `pause`.
- The server then publishes `playback` to the room topic. The chat line ("Ana paused") is derived client-side from `action` + `by`.
- The server never extrapolates past the duration. It doesn't know the duration, so "ended" is local and each client just stops at the end. This is an open item for M2 (autoplay-next is out of scope).

**Size check:** `playback` is about 150 B. The snapshot grows by the same amount, so the 16 KB server→client cap is unaffected. `control` is under 120 B, far below the 4 KB client→server cap.

## 7. ADR to write with the contract issue

**ADR 0011 "YouTube player integration":**
- The official IFrame API is attached to our own iframe.
- Path-scoped `script-src`.
- Nocookie host swap inside `tvFrame()`. This clarifies ADR 0003: the wire URL stays canonical `www.youtube.com`, and the src is *derived* from it.
- Sandbox adds `allow-popups allow-popups-to-escape-sandbox`.
- `controls=0` + our own control bar.
- Sync thresholds from §2.3.

## 8. Suggested M1b issue breakdown

| # | Issue | Owner | Blocked by |
|---|---|---|---|
| 1 | **Contract: playback + clock ping** (§6) + ADR 0011 | Lead Engineer | M1a board approval |
| 2 | Server: `ping`/`pong`, playback state in `Room`, `control` handling + limiter, reset on embed change, relay-latency coverage | Lead Engineer (implementer subagent) | 1 |
| 3 | Web: clock-sync module (burst, window, min-RTT, resync on visibility) | Lead Engineer (implementer subagent) | 1 |
| 4 | Web: `PlayerAdapter` (YouTube, lazy loader, `tvFrame` params, nocookie, sandbox, CSP) + `decide()` + sync loop + control bar + autoplay-blocked fallback | Lead Engineer (implementer subagent) | 1 (3 for integration) |
| 5 | Layout: TV ≥ 356×200 CSS px after scaling, no-overlap test for bubbles/tags/controls, control-bar placement | Lead Engineer + Creative Designer (art only, non-blocking) | — (can start after M1a approval) |
| 6 | QA: fake `iframe_api` fixture + sync e2e specs (§4.2.3) + `sync.spread` perf metric + frame p95 with video | QA Engineer | 1 (fixture can start now from the public API surface) |
| 7 | QA: real-network manual checklist (§4.3) at M1b sign-off | QA Engineer | 2, 3, 4, 5 |

Issues 2, 3 and 4 touch disjoint paths (`apps/server/**`, `apps/web/src/clock*`, `apps/web/src/player*|tv.ts|sync*`), so they can run in parallel worktrees.
