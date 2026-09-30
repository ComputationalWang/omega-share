# M2 research: Twitch + Vimeo player sync, embed policy, iframe safety, test strategy

[OME-118](/OME/issues/OME-118) · 2026-09-30 · Lead Engineer · research only. Nothing here changes code or `packages/shared`. The contract issue ([OME-122](/OME/issues/OME-122)) implements §8 as written.

This follows the M1b model (`docs/research/m1b-youtube-sync.md`, ADR 0011, ADR 0013) and keeps its rules: the server owns playback (ADR 0002), a parsed `Embed` is the only thing that becomes an iframe (ADR 0003), and budgets come from `docs/perf-budgets.md`.

**Evidence labels.** **[doc]** is an official developer doc page. **[code]** is the vendor's served or published SDK source, quoted. **[probe]** is a response we fetched from the vendor on 2026-09-30. **[inferred]** is reasoning that has not been verified yet. Every **[inferred]** item that matters becomes a line in the real-provider checklist (§7.3).

**Sources**
- Twitch: Embed overview <https://dev.twitch.tv/docs/embed/> (EM), Video & Clips <https://dev.twitch.tv/docs/embed/video-and-clips/> (VC), Everything <https://dev.twitch.tv/docs/embed/everything/> (EV), served SDK `https://player.twitch.tv/js/embed/v1.js` (byte-identical to `https://embed.twitch.tv/embed/v1.js`; 19 719 B raw, 6 462 B gzip -9) [probe].
- Vimeo: Player SDK README and source <https://github.com/vimeo/player.js> (v2.30.4, MIT; `src/player.js`, `src/lib/postmessage.js`, `src/lib/functions.js`, `src/lib/embed.js`), served SDK `https://player.vimeo.com/api/player.js` (24 420 B raw, 7 915 B gzip -9) [probe], player parameters <https://help.vimeo.com/hc/en-us/articles/12426260232977>, privacy settings <https://help.vimeo.com/hc/en-us/articles/12426199699985>, oEmbed `https://vimeo.com/api/oembed.json` [probe].

## TL;DR: the recommendation

| | Twitch | Vimeo |
|---|---|---|
| Accept | Live channels and VODs. **Reject clips** (no JS API) and collections. | Public and unlisted (`h=`) videos. **Reject live events** (`/event/`) and showcases. |
| Controller | Official `Twitch.Player` SDK, lazy. It builds its own iframe from options we derive from the parsed embed; we verify the result (§4.1). | Official `Vimeo.Player` SDK, lazy, **attached to our own iframe** (same pattern as ADR 0011). |
| Rate | **Never settable.** VOD → `seek-only`. Live → `live` mode (play/pause only). | Settable only if the owner's plan allows it (Starter+). Probe at runtime; on rejection → `seek-only`. |
| Seek | VOD yes. Live no. | Yes. |
| Time | Cached from pushed state; the adapter extrapolates. | Async getters; the adapter caches `timeupdate` (~250 ms) and extrapolates. |
| Refusal signal | Error codes over the SDK; wrong `parent` shows an in-player error with **no** signal → ready timeout. | `ready` rejects with a named error (`PrivacyError`, `PasswordError`, …). |
| Cost | 6.5 KB gzip script, lazy. No timers, no rAF. | 7.9 KB gzip script, lazy. No timers, no rAF. |
| Size rule | Player **≥ 400×300** (so ≥ 534×300 at 16:9). The TV minimum must grow for Twitch. | None beyond ours. |

The contract change (§8): `PROVIDERS = ["youtube", "twitch", "vimeo"]`, `EmbedSchema` becomes a variant on `provider` (YouTube's shape is unchanged), a pure `playbackCaps(embed)` in shared, and `control` identifies the embed by its canonical `url` instead of a YouTube `videoId`.

## 1. Sync controls

### 1.1 Twitch (`Twitch.Player`, EV/VC)

| Need | API | Notes |
|---|---|---|
| Ready | `READY` event (`"ready"`) [code] | Commands before it are dropped by our adapter, as for YouTube. |
| Play / pause | `play()`, `pause()` [doc] | Sent as `{eventName: 3 / 2, params, namespace: "twitch-embed-player-proxy"}` [code]. |
| Seek | `seek(seconds)` [doc] | "Does not work for live streams" [doc, VC]. |
| Time | `getCurrentTime()`, `getDuration()` [doc] | VODs only [doc]. Returns a **cached** value with no extrapolation: `getCurrentTime(){return this._playerState.currentTime}` [code]. The cache is overwritten by `UPDATE_STATE` messages from the iframe (`Object.assign({}, this._playerState, t.params)`) [code]. The push cadence is not documented [inferred: measure in W1]. |
| State | `isPaused()`, `getEnded()` [doc]; `_playerState.playback` ∈ `"Idle" \| "Ready" \| "Buffering" \| "Playing" \| "Ended"` [code] | `isPaused()` is `playback === "Idle"` [code]. "Buffering or seeking is considered playing" [doc]. So **buffering is readable only from the state string**, not from an event. |
| Events | `ready`, `play`, `playing`, `pause`, `ended`, `online`, `offline`, `playbackBlocked`, `seek`, `captions`, plus `video.ready/play/pause` and `authenticate` on the full Embed [code] | PLAY = "unpaused, will either start video playback or start buffering"; PLAYING = "started video playback"; SEEK = "user has used the player controls to seek a VOD, the seek() method has been called, or live playback has seeked to sync up after being paused" [doc]. |
| Rate | **None.** There is no setter in the docs or the served code. The only rate is the read-only `stats.videoStats.playbackRate` [code]. | → VODs run `seek-only` (ADR 0013's ladder bottom rung). |
| Volume | `setVolume(0–1)`, `setMuted(bool)`, `getMuted()` [doc] | Per-user, as with YouTube. |
| Ads | **Nothing.** No ad event, state or string in v1.js or the docs [code, doc]. | Pre-rolls play inside the iframe. See §1.4. |
| Errors | `error` event relayed from the iframe [code]. The code enum includes `GeoBlocked=1`, `UnauthorizationEntitlements=5`, `VodRestricted=6`, `Network=2000`, `ContentNotAvailable=5000`, `Offline=8002`, `FatalAuth=8003` and more (full list in §2.1) [code]. | When and with what payload `error` fires is decided inside the iframe and is not documented [inferred]. |

**Live vs VOD vs clip**
- **Live channel** (`?channel=<login>`): play and pause work. Seek, time and duration don't [doc]. A resume after a pause jumps to the live edge ("live playback has seeked to sync up after being paused") [doc]. So the only thing we can share is *playing or paused*, which is what the spec asks for ("only pause/play-from-live is shared"). **Accept.**
- **VOD** (`?video=v<id>`): play, pause, seek and time work. No rate. **Accept, `seek-only`.**
- **Clip** (`clips.twitch.tv/embed?clip=<slug>`): "does not support the JavaScript interactive embed" [doc, VC]. We can't sync it. **Reject** in the extension and the server allowlist.
- **Collection** (`?collection=`): a playlist; autoplay-next would move the player off the room's video. **Reject.**

**Recommendation:** VODs use the existing `seek-only` mode with its 500 ms threshold. Twitch VODs are HLS, so a seek probably rebuffers for longer than a YouTube seek [inferred]. The existing seek-latency EWMA (`updateSeekLatency`) compensates. W1 measures the seek latency, and if seek-only oscillates, W1 raises Twitch's seek-only threshold (a web-side constant, not a contract change).

### 1.2 Vimeo (`Vimeo.Player`, README)

| Need | API | Notes |
|---|---|---|
| Ready | `ready()` promise; resolves on the `ready` event or a `ping` reply [code, `player.js:~100`] | If the iframe's first reply is an `error` with `method: "ready"`, the promise **rejects** with that error's `name` [code, `player.js:~90`]. That's our refusal signal (§2.2). |
| Play / pause | `play()`, `pause()` → `Promise<void, PasswordError \| PrivacyError \| Error>` [doc] | |
| Seek | `setCurrentTime(s)` → `Promise<number, RangeError \| PasswordError \| PrivacyError \| Error>` [doc] | |
| Time | `getCurrentTime()`, `getDuration()`, `getPaused()`, `getEnded()`, `getBuffered()` [doc] | **All async**: each is a postMessage round trip [code, `postmessage.js`]. Our `PlayerAdapter.time()` is synchronous, so the adapter keeps the last `timeupdate` value and extrapolates (§6). |
| Events | `play`, `playing`, `pause`, `ended`, `timeupdate`, `progress`, `seeking`, `seeked`, `bufferstart`, `bufferend`, `playbackratechange`, `volumechange`, `durationchange`, `loaded`, `error` [doc] | `timeupdate` "generally fires every 250ms" and carries `{seconds, percent, duration}` [doc]. `bufferstart`/`bufferend` give buffering directly. |
| Rate | `setPlaybackRate(r)`, "on a scale from 0 to 2 (available to PRO and Business accounts)" → `Promise<number, RangeError \| Error>` [doc] | The embed parameter `speed` "enable[s] the playback rate API" and requires a Starter+ account [doc, help]. So it depends on **who uploaded the video**. We can't know that from the URL. |
| Volume | `setVolume(0–1)`, `setMuted(bool)` [doc] | |
| Ads | Vimeo documents no ads in the player [doc: none listed]. | We still keep the `ad` guard generic. |
| Live | `vimeo.com/event/<id>` is served by a separate Live product. The SDK docs don't cover what's controllable [doc: absent]. | **Reject** in M2. |

**Recommendation:** start every Vimeo embed in `fine` mode with `rates()` reporting `[1]` until a probe succeeds. On ready, the adapter calls `setPlaybackRate(1)`. If that rejects, `rates()` stays `[1]`, so `initialRateMode()` → `seek-only`. If it resolves, report `[0.75, 1, 1.25]` plus the 0.05 grid. The effective-rate check (ADR 0013) still catches a player that accepts but ignores the rate. Keep the 0.05 grid for Vimeo too: one code path, and ADR 0013 already says the step can become per-adapter later if needed. Whether `setPlaybackRate(1)` on a free-plan video rejects (rather than silently resolving) is **[inferred]** → checklist §7.3 V3. If it resolves anyway, the effective-rate check drops us to seek-only within about 2 s, which is still correct.

### 1.3 Where user intent comes from

- YouTube runs with `controls=0`, so almost every change comes from us.
- **Twitch has no way to hide its controls.** VC/EV list no `controls` parameter [doc], and the SDK only forwards the options we pass [code].
- **Vimeo's `controls=0` needs a Starter+ owner** [doc, help], so free-plan videos show controls.

So on both providers, users will click play, pause and seek inside the player. The adapters must turn unexplained `play`/`pause`/`seek(ed)` events into `intent` events, and ignore the echoes of our own commands. This is the same `command(expected)` bookkeeping `attachYouTube` already does (`apps/web/src/player/youtube.ts:55`). The control bar stays the primary UI.

### 1.4 Buffering, ads and live-edge behaviour

- **Buffering:** Twitch → `playback === "Buffering"` from the pushed state. Vimeo → `bufferstart`/`bufferend`. Both map to `PlayerState "buffering"`, and `decide()` makes no corrections while in it (unchanged).
- **Twitch pre-rolls/mid-rolls:** there is no signal at all [code, doc]. The iframe probably reports `Playing` while the ad plays, with `currentTime` frozen or absent [inferred]. The adapter infers `ad` when **the pushed state says Playing but `currentTime` hasn't advanced for > 2 s on a VOD**, the same shape as YouTube's `inAd()` guard. On live, an ad has no effect on sync anyway (play/pause only). → checklist T4.
- **Live drift between viewers** comes from HLS latency (`stats.videoStats.hlsLatencyBroadcaster` [code]) and we can't correct it without seek or rate. **The ≤ 500 ms spread budget can't apply to live streams.** → Open question B1.

## 2. Embed policy

### 2.1 Twitch

- **`parent` is mandatory for iframes:** "Domain(s) that will be embedding Twitch. You must have one parent key for each domain your site uses" [doc, VC]. A missing or wrong parent "will trigger a playback error message that will direct end users to click through to Twitch" [doc, EM]. The SDK needs it only for "any domain(s) other than the one that instantiates the Twitch embed" [doc, VC], because it always appends the page's own host:
  ```js
  function b(e){const t=document.domain;if(!e)return[t];const r=Array.isArray(e)?e:[e];return t&&-1===r.indexOf(t)?r.concat(t):r}
  ```
  [code]. `document.domain` is the hostname with no port or scheme [inferred, HTML spec].
- **HTTPS:** "Domains that use Twitch embeds must use SSL certificates" [doc, EM]. The docs say nothing about `localhost`, ports or subdomains [doc: absent].
- **Tunnel hostname:** each hostname the room is served from must be in `parent`. Because the SDK derives it from `document.domain`, **a random tunnel hostname works automatically** as long as the tunnel serves the site over HTTPS [inferred]. We pass `parent: [location.hostname]` explicitly anyway, so the value is visible in our code and tests. → checklist T1 (ngrok), T2 (`http://localhost:5173`).
- **Wrong parent sends no signal** [inferred: nothing in the SDK relays it; the error is an in-player page]. Recommendation: a **10 s ready timeout** (the same as the YouTube loader) → the site notice "Twitch refused to play here" plus a frozen transport, the same UI path as OME-110.
- **Autoplay:** `autoplay` defaults to true for the player; "Minimum size requirements and visibility are necessary for autoplay to begin" [doc]. **"Embedded video windows must be at least 400x300 pixels"** [doc, VC]. Unmuted autoplay that the browser blocks fires `playbackBlocked` ("Usually fired after an unmuted autoplay or unmuted programmatic call on play()") [doc] → our `autoplay-blocked` event → `setMuted(true)` + `play()` + the Unmute button (unchanged UX).
- **Mature content, subscriber-only VODs, geo-blocks:** the docs say nothing [doc: absent]. The code has `UnauthorizationEntitlements=5`, `VodRestricted=6`, `GeoBlocked=1`, `PREMIUM_CONTENT` and `vod_manifest_restricted` [code]. The mature-content gate is an interstitial inside the player that needs a click from each viewer [inferred]. Recommendation: map these codes to `restricted` (§6.3) and show a notice. A mature gate that just sits there shows up as "not playing while the room plays", and `decide()` keeps sending `PLAY`. The Unmute/notice area shows "Click the player to continue" after 5 s of that [inferred UX; checklist T5].
- **Offline channel:** the `offline` event [doc] → a notice ("<channel> is offline"). The room's playback state stays as it is. `online` clears the notice and `decide()` resumes.
- **Policy:** "Embeds must utilize only Twitch-approved player elements and should not be obscured in any way by other page elements" [doc, EM 1.3]. ADR 0012 already makes the TV an unscaled box nothing overlaps. The Twitch Developer Services Agreement didn't render without JavaScript, so it isn't reviewed here → Open question B2.

### 2.2 Vimeo

- **Privacy:** "Unlisted" adds "an additional set of numbers (what we call the privacy hash)" to the URL, and such videos "can be embedded anywhere online" [doc, help]. The SDK needs the full URL with the `h` parameter for unlisted videos [doc, README]. "Private" videos are "not viewable … even if embedded elsewhere" [doc, help]. Password-protected videos reject `play()` with `PasswordError` [doc].
- **Domain-level privacy ("specific domains"):** Vimeo's help (via search summary only; not opened) says a disallowed domain shows a privacy error, and that a `no-referrer`/`same-origin` referrer policy breaks the check [inferred from summary]. The SDK surfaces an iframe `error` for `method: "ready"` as a rejected `ready()` with `error.name` [code]. **Which `name` a domain refusal uses is not verified** → checklist V2. Recommendation: map `PrivacyError` → `refused`, `PasswordError` → `restricted`, any other `ready` rejection → `other`, and also use the 10 s ready timeout. All of these go to the OME-110 notice path.
- **Referrer:** Vimeo's own oEmbed markup sets `referrerpolicy="strict-origin-when-cross-origin"` [probe]. That's our page policy already. Keep it.
- **Parameters** [doc, help]:
  - `autopause` (default true): "The Vimeo player only plays one video at a time". **Set `autopause=0`**, so a second Vimeo tab or player can't pause ours.
  - `autoplay=1`; `muted` for the fallback.
  - `playsinline` (default true).
  - `keyboard=0`, the same idea as YouTube's `disablekb`.
  - `dnt=1`: "blocks the player from collecting session data and analytics". **Set it**, for privacy; it affects nothing we use.
  - `controls=0`: requires Starter+ [doc]. Send it anyway; on free-plan videos the controls just stay (§1.3).
  - `title=0&byline=0&portrait=0`: cosmetic, "Default: Value specified in embed settings". Send them.
  - Don't send `background` (Starter+, and it mutes, loops and hides everything), `speed` (a UI menu; the rate API doesn't need it from us), or `#t` (we seek after ready instead).
- **Mature content:** Vimeo has content ratings, but the SDK documents nothing about a gate [doc: absent] → checklist V4.

### 2.3 Autoplay summary (both)

"Enter room" is the user activation, and `allow="autoplay"` delegates it, exactly as for YouTube. Twitch reports a block with `playbackBlocked` [doc]. Vimeo's `play()` probably rejects with a DOM `NotAllowedError` name when blocked [inferred; README lists only Password/Privacy] → the adapter treats **any** `play()` rejection that isn't Password/Privacy as `autoplay-blocked` once, retrying muted. → checklist V5.

## 3. Canonical URLs

Rule (ADR 0003, unchanged): the canonicalizer extracts ids, validates them against strict regexes, and **rebuilds** the embed URL from constants plus ids. It never passes input through. Ids that only ever go into a query value or a path segment after passing these regexes can't break out.

### 3.1 Twitch

| Input form | Kind | Extract |
|---|---|---|
| `https://(www.\|m.)twitch.tv/<login>` (optional trailing `/`) | live | `login` = first path segment, lowercased |
| `https://(www.\|m.)twitch.tv/videos/<digits>` | vod | digits |
| `https://player.twitch.tv/?channel=<login>` (other params ignored) | live | `channel` (exactly one) |
| `https://player.twitch.tv/?video=v<digits>` or `?video=<digits>` | vod | digits (the player requires the `v` prefix [doc]; we accept both on input) |
| `clips.twitch.tv/…`, `twitch.tv/<login>/clip/<slug>`, `?collection=` | clip / collection | **reject** |
| `?channel=` **and** `?video=` together | ambiguous | **reject** (Twitch would use only `channel` [doc]; we refuse to guess) |

- **Login:** `/^[a-z0-9_]{1,25}$/` after lowercasing. Twitch help says usernames are 4–25 characters (search snippet, not opened); older accounts are shorter [inferred]. The character set is **[inferred]**. Everything the regex admits is URL-safe, so a looser lower bound costs nothing.
- **Reserved first segments** on `twitch.tv` that are pages, not channels [inferred; no primary list]: `directory, videos, settings, subscriptions, inventory, wallet, drops, turbo, prime, friends, messages, search, downloads, jobs, p, store, login, signup, logout, broadcast, moderator, popout, embed, following, u`. **Reject** these as logins. A false positive rejects one channel named like a page; a false negative gives an "offline"/error player, which is harmless.
- **VOD id:** `/^[1-9][0-9]{0,11}$/` [inferred: numeric per doc examples, e.g. `v40464143`].
- **Canonical `Embed.url`:** live `https://player.twitch.tv/?channel=<login>`, vod `https://player.twitch.tv/?video=v<digits>`. `parent`, `autoplay` and `muted` are added at render time, like the nocookie swap, and never go on the wire.

### 3.2 Vimeo

| Input form | Extract |
|---|---|
| `https://(www.)vimeo.com/<id>` | id |
| `https://(www.)vimeo.com/<id>/<hash>` | id + hash (unlisted) |
| `https://(www.)vimeo.com/channels/<name>/<id>` | id |
| `https://(www.)vimeo.com/groups/<name>/videos/<id>` | id |
| `https://(www.)vimeo.com/album/<a>/video/<id>`, `/showcase/<s>/video/<id>` | id |
| `https://player.vimeo.com/video/<id>` with optional `?h=<hash>` (other params ignored) | id (+ hash) |
| `vimeo.com/event/…`, `/showcase/<s>` without a video, anything else | **reject** |

- **Hosts:** exactly `vimeo.com`, `www.vimeo.com`, `player.vimeo.com`. The SDK's own `isVimeoUrl` also admits `*.videoji.hk`, `*.videoji.cn`, `*.vimeo.work` [code, `functions.js:88`]. **We don't** (custom/white-label domains).
- **Id:** `/^[1-9][0-9]{0,11}$/`. The SDK matches `\/video\/\d+` [code, `functions.js:98`].
- **Hash:** `/^[0-9a-f]{6,32}$/` after lowercasing [inferred: hex in every public example; help only says "an additional set of numbers"]. The hex charset is what keeps it safe in a query.
- **Canonical `Embed.url`:** `https://player.vimeo.com/video/<id>`, or `https://player.vimeo.com/video/<id>?h=<hash>`. Render-time parameters (§2.2) are appended by `tvFrame()`, never sent.

## 4. Iframe safety

### 4.1 Who builds the iframe

- **Vimeo: we do.** `new Player(element)` accepts an existing iframe as long as its `src` passes `isVimeoUrl` [code, `player.js:~66`]. So `tvFrame()` stays the only iframe builder, as in ADR 0011.
- **Twitch: the SDK does, and it can't attach to ours.** `render()` is `this._target.appendChild(this.buildIframe())` [code], and the builder sets `src`, `allow` and `sandbox` itself:
  ```js
  const r=`https://${t}.twitch.tv?${m.stringify(Object.assign({},e,{parent:b(e.parent),referrer:document.location.href}))}` … n.setAttribute("allow","autoplay; fullscreen") … let i="allow-modals allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"; … (i+=" allow-storage-access-by-user-activation")
  ```
  [code]. Every option we pass becomes a query parameter.
  - **Options considered:**
    - (a) Let the SDK build the iframe, but from a frozen options object derived only from the parsed embed. Then check the iframe it produced.
    - (b) Build our own iframe and speak the SDK's postMessage protocol ourselves. It is small and fully visible in v1.js (commands `{eventName: 0–11, params, namespace: "twitch-embed-player-proxy"}` sent with `postMessage(r, "*")`; state arrives as `UPDATE_STATE`, events on namespace `"twitch-embed"`) [code].
  - **Recommendation: (a).**
    - The protocol is undocumented and versioned only with the served SDK. ADR 0011 rejected hand-rolled protocols for exactly this reason.
    - EM 1.3 requires "Twitch-approved player elements".
    - **Checks (W1):** the element we pass in is a fresh container inside `.tv`. We don't touch the iframe's attributes (sandbox changes after insertion wouldn't apply to the current navigation anyway). Straight after `render`, the adapter checks that there is exactly one child iframe, that its `src` origin is `https://player.twitch.tv`, and that its `channel`/`video` parameters equal the embed's. If any check fails, it removes the container and shows the error notice.
  - **Accepted deviations from ADR 0011's sandbox** (record them in the contract ADR):
    - `allow-modals` and `allow-storage-access-by-user-activation`. The second lets Twitch's login and subscription state work inside the player.
    - The SDK's `allow` list is `autoplay; fullscreen`. That's narrower than ours.
    - There is still no `allow-top-navigation*` and no `allow-forms`.
  - **Privacy:** the SDK puts `referrer=document.location.href` in the iframe URL [code]. That sends the full room path (`/r/<room>`) to Twitch. Tell the tunnel research ([OME-119](/OME/issues/OME-119)): if a room id ever becomes a secret, Twitch rooms leak it.

### 4.2 Attributes

| | Twitch (set by the SDK) | Vimeo (set by `tvFrame()`) |
|---|---|---|
| `sandbox` | `allow-modals allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox` (+ `allow-storage-access-by-user-activation`) [code] | ours from ADR 0011: `allow-scripts allow-same-origin allow-presentation allow-popups allow-popups-to-escape-sandbox` |
| `allow` | `autoplay; fullscreen` [code] | `autoplay; fullscreen; picture-in-picture; encrypted-media`. Vimeo's oEmbed also lists `clipboard-write; web-share` [probe]; we don't need them. The SDK adds `encrypted-media` itself on DRM failure [code, `embed.js:~360`]. |
| `referrerpolicy` | none (the page's `strict-origin-when-cross-origin` meta applies) | `strict-origin-when-cross-origin`, the same as Vimeo's oEmbed [probe] |

Checklist V1 verifies that Vimeo plays under our sandbox. If it doesn't, the fallback is adding whatever single token the console asks for, recorded in the ADR.

### 4.3 CSP (`apps/web/index.html:8`)

| Directive | Today | M2 |
|---|---|---|
| `script-src` | `'self' https://www.youtube.com/iframe_api https://www.youtube.com/s/player/` | + `https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js` (exact files) |
| `frame-src` | `https://www.youtube.com https://www.youtube-nocookie.com` | + `https://player.twitch.tv https://player.vimeo.com` |

- Both SDKs are single self-contained files. There are no dynamic imports or further script loads in v1.js [code] or in the player.js source [code]. So exact-file sources are enough. W1/W2 must verify that no CSP violation shows up.
- Everything the players fetch (Twitch HLS, `f.vimeocdn.com`, `i.vimeocdn.com`) is requested by the iframe, under the vendor's CSP, not ours. Vimeo's player page CSP, for example, is `script-src 'self' https://f.vimeocdn.com` [probe].

### 4.4 postMessage origin checks

- **Vimeo SDK:** drops a message unless `isVimeoUrl(event.origin)` **and** `this.element.contentWindow === event.source` [code, `player.js:~82`]. It posts to `'*'` until the first reply, then pins `player.origin` to that reply's origin [code, `postmessage.js`]. The `source` check makes the loose origin regex safe.
- **Twitch SDK:** checks `event.source === iframe.contentWindow` and the namespace only, with no origin check [code]. Commands go out with `postMessage(…, "*")` [code]. That's acceptable, because `source` identity is unforgeable and the iframe is ours. The commands carry nothing secret.
- **Our code** never adds its own `message` listener for either provider. The SDKs are the only listeners (supply-chain risk as in ADR 0011).

### 4.5 Without the vendor SDK?

- **Vimeo:** feasible. The `{method, value}` / `{event, data}` protocol is small and public in the MIT source. But it's the vendor's to change. **Recommendation: use the served SDK**, for the same reasons as ADR 0011, and because the served file is versioned together with the player it talks to. Bundling `@vimeo/player` from npm (MIT) would pin a copy that can drift from the live player, and it pulls in two polyfills we don't need.
- **Twitch:** see §4.1(b). Possible, not recommended.

## 5. Cost

- **Bundle:** zero. Both SDKs are served by the vendor and inserted by a loader only when the room's embed is that provider, once per page. It's the `createYouTubeLoader` pattern (`apps/web/src/player/youtube-loader.ts:22`) generalised to a per-provider loader. The adapters themselves are about 2 KB each in the lazy room chunk. Initial JS is unaffected.
- **Network:** Twitch 6.5 KB gzip, Vimeo 7.9 KB gzip [probe]. That's comparable to YouTube's 12.4 KB.
- **Main thread:** neither SDK has `setInterval`, `setTimeout` or `requestAnimationFrame` [code: grep of v1.js and the player.js sources]. Work is one `message` event per push: Vimeo `timeupdate` ~4/s [doc], Twitch `UPDATE_STATE` at an unmeasured cadence [inferred]. The sync loop stays a 250 ms timer, off the PixiJS ticker.
- **Frame risk:** YouTube's raw p95 is 16.80 ms. Video decode runs in the iframe's process (site isolation), so it shouldn't touch our frame time [inferred, as in M1b §5]. The one Twitch-specific risk is live HLS, which is heavier than a VOD. **W1 and W2 each report raw and quantised frame p95 with their provider playing, and Q2 measures each provider as a merge-blocking row** (the M2 plan already says so). If Twitch's `UPDATE_STATE` turns out to be per-frame, the adapter must not do more than an assignment per message (no allocation, no emit unless the state changed).

## 6. Adapter shape

### 6.1 Capabilities: two sources

- **Static, from the embed** (shared, pure: `playbackCaps(embed)`, §8). The server needs it too:
  - `seek`: false for Twitch live.
  - `live`: true for Twitch live.
  - `rate`: `"yes"` for YouTube, `"probe"` for Vimeo, `"no"` for Twitch.
- **Runtime, from the player** (web only): `rates()` as today. Vimeo reports `[1]` until the probe succeeds.

### 6.2 `PlayerAdapter` changes (`apps/web/src/player/adapter.ts`)

- **Keep the interface.** Add only what the loop can't derive:
  - `readonly caps: PlaybackCaps`, copied from `playbackCaps(embed)` at attach.
  - The `error` event changes from `{ code: number }` to `{ reason: PlayerErrorReason; code: string }`, with `PlayerErrorReason = "refused" | "not-found" | "restricted" | "offline" | "timeout" | "other"`. YouTube maps 101/150 → refused and 100 → not-found (so OME-110's `playerErrorText` switches on `reason`, not on YouTube's numbers). Twitch maps 5/6/1 → restricted, 5000 → not-found and `offline` → offline. Vimeo maps Privacy → refused and Password → restricted. The loader and ready timeouts map to timeout.
  - An `online` event isn't needed. `offline` is an error that clears itself: the adapter emits `{type: "state", state}` again when playback resumes, and the notice clears on any non-error state.
- **Twitch live:** `seek()` is a no-op, `time()`/`duration()` return 0, and `rates()` returns `[1]`.
- **Both new adapters extrapolate `time()`** from the last pushed value: `t + (performance.now() − at) / 1000 × rate` while playing, capped at +1 s. That's the same rule as YouTube's widget [M1b §1.2]. They mark a drift sample stable only after `stableForMs ≥ 500` (unchanged).

### 6.3 How the sync loop degrades

| Caps | `RateMode` | `decide()` behaviour |
|---|---|---|
| YouTube (`rate: "yes"`) | fine → burst → seek-only (unchanged) | unchanged |
| Vimeo, probe OK | same as YouTube | unchanged |
| Vimeo, probe rejected; Twitch VOD | `seek-only` from the start (`initialRateMode([1])`) | seek above 500 ms, otherwise nothing |
| Twitch live (`live: true`) | new mode **`live`** | only `PLAY`/`PAUSE` to match `room.playing`. No drift samples, no seeks, and `hardSeek` becomes play/pause. |

- `live` is a fourth `RateMode` value, chosen by `initialRateMode(rates, caps)` when `caps.live`.
- `decide()` returns before `expectedPosition()` in that mode, so the pure function stays table-testable.
- The control bar hides the scrubber and time readout for `live` (the designer's "live transport", [OME-120](/OME/issues/OME-120)).
- A user seek intent can't happen on live, and the server rejects it anyway (§8).

### 6.4 Layout

Twitch's 400×300 minimum [doc] exceeds ADR 0012's 356×200. **Recommendation:** `roomLayout(width, provider)` takes a per-provider minimum. Twitch → 534×300 (16:9 ≥ 400×300). The page scrolls sideways below 546 px, which is ADR 0012's rule with a bigger number. Record it as an amendment to ADR 0012 in the contract issue's ADR. W0 owns it.

## 7. Test strategy

### 7.1 Fake fixtures (Q1, [OME-121](/OME/issues/OME-121))

Same approach as the fake `iframe_api` ([OME-85](/OME/issues/OME-85)): `e2e/support/network.ts` serves the fake SDK **at the real URL**, so the production bundle and the real adapters and loaders run unchanged.

**`fake-twitch-embed.js`** served at `https://player.twitch.tv/js/embed/v1.js`. Blank page for `https://player.twitch.tv/?*`.
- `window.Twitch.Player(target, options)`:
  - It must **create and append an iframe** whose `src` is built the way the real SDK builds it (`https://player.twitch.tv?<options + parent + referrer>`), with the real SDK's `sandbox`/`allow` values. W1's post-render checks then run against a realistic element.
  - It records the `options` it got.
- Methods: `play, pause, seek, getCurrentTime, getDuration, isPaused, getEnded, setMuted, getMuted, setVolume, addEventListener/removeEventListener`.
- Event constants: `Twitch.Player.READY/PLAY/PLAYING/PAUSE/ENDED/ONLINE/OFFLINE/PLAYBACK_BLOCKED/SEEK`, with the real string values (§1.1).
- **Media clock:** `performance.now()`-driven. It updates `currentTime` in the *cached* state only on a push timer (default 250 ms, settable), so the adapter's extrapolation is exercised. It never honours rates (there's no setter).
- **Live mode** (`channel` option):
  - `getCurrentTime()` returns 0.
  - `seek()` is ignored.
  - Resume after pause emits `SEEK`, then `PLAYING` (the live-edge jump).
- `window.__fakeTwitch` hooks:
  - `buffering(ms)` sets playback to `"Buffering"`.
  - `ad(ms)`: state `Playing`, clock frozen, no event.
  - `offline()` / `online()`.
  - `playbackBlocked()`.
  - `error(code)` with codes 1, 5, 6 and 5000.
  - `neverReady()` emulates a wrong `parent`.
  - `seekLatency(ms)`.
  - `userPause()` / `userSeek(s)` emulate clicks inside the player.

**`fake-vimeo-player.js`** served at `https://player.vimeo.com/api/player.js`. Blank page for `https://player.vimeo.com/video/*`.
- `window.Vimeo.Player(iframe)`: it **throws unless the element is an IFRAME with a `player.vimeo.com/video/<digits>` src**, like the real one. It records the src's query.
- All getters and commands return **Promises**. `ready()` resolves after a settable delay, or rejects with `{name: "PrivacyError" | "PasswordError"}`.
- Events: `play, playing, pause, ended, seeking, seeked, timeupdate ({seconds, percent, duration}, ~250 ms), bufferstart, bufferend, playbackratechange, error, loaded`.
- Media clock honours `setPlaybackRate` **only if** a `rateAllowed` hook is true. Otherwise `setPlaybackRate` rejects with `{name: "Error"}`. A third setting, `rateIgnored`, resolves but plays at 1×, to drive the effective-rate fallback.
- `window.__fakeVimeo` hooks: `buffering(ms)`, `privacy()`, `password()`, `autoplayBlocked()` (the next unmuted `play()` rejects `NotAllowedError`), `rateAllowed(bool)`, `rateIgnored(bool)`, `seekLatency(ms)`, `userPause()`, `userSeek(s)`.

**Specs (Q2, [OME-131](/OME/issues/OME-131))**, 8 contexts via `joinRoom`, per provider:
1. Twitch VOD + Vimeo, rate rejected (seek-only): play, pause and seek each give spread ≤ 500 ms 2 s later. A late joiner lands within 500 ms.
2. Vimeo, rate allowed: same as YouTube (fine nudges), plus `rateIgnored` → mode drops to seek-only and spread still ≤ 500 ms.
3. Twitch live:
   - Pause and play propagate to all 8 clients within the relay budget.
   - No client ever calls `seek`. The fake records calls.
   - The scrubber is hidden.
   - A crafted `control` with a position is applied as play/pause only (server test too, S1).
4. Buffering for 3 s on one client doesn't pause the room. That client catches up.
5. `ad(10 s)` on one Twitch VOD client doesn't pause the room.
6. A click-pause inside the player (`userPause`) becomes a room pause, and `userSeek` becomes a room seek (VOD and Vimeo).
7. Refusals: Twitch `neverReady` (ready timeout), `error(6)`, Vimeo `privacy()` and `password()` each show the site notice and freeze the transport (the OME-110 behaviour). `offline()` shows the offline notice, and `online()` clears it.
8. Autoplay blocked (Twitch `playbackBlocked`, Vimeo `autoplayBlocked`): the player is muted and playing, and the Unmute button works.
9. Iframe attributes:
   - Vimeo's `src` is `https://player.vimeo.com/video/<id>[?h=]` plus exactly the §2.2 parameters, with our sandbox/allow/referrerpolicy.
   - Twitch's options contain only `channel|video`, `parent: [location.hostname]`, `autoplay`, `muted`, `width` and `height`.
   - The CSP still blocks a non-allowlisted script.
10. Layout: with a Twitch embed, the TV is ≥ 400×300 at widths 360–1920.
11. Perf: `site.frameP95` and `sync.spread` run with each fake provider playing. They are rows in `bun run perf`.

**Unit (W0/W1/W2/S1, `bun test`):**
- canonicalizer tables for every row in §3, including rejects: clips, collections, events, reserved logins, `channel`+`video` together, foreign hosts, ports and credentials;
- `playbackCaps` for each kind;
- `decide()` in `live` mode;
- the Vimeo probe → `rates()`;
- the error-reason mapping for all three providers;
- the server rejecting seek on live embeds.

### 7.2 What only a real provider can prove

These can't be faked meaningfully: `parent` handling, rate limits that depend on the owner's plan, ads, gates, and the real push cadence. They go in Q4's opt-in checklist ([OME-133](/OME/issues/OME-133)), next to `e2e/real/real-youtube.real.ts`, run with `bun run e2e:real`.

### 7.3 Real-provider checklist (Q4)

**Twitch**
- T1. Over the ngrok HTTPS hostname, a live channel and a VOD play with `parent` = the tunnel host, and the SDK doesn't add a second host.
- T2. On `http://localhost:5173`, does Twitch accept `parent=localhost` over plain HTTP? Record the answer. If not, local dev uses the fake SDK and the notice path.
- T3. A deliberately wrong `parent` shows the in-player error. Our ready timeout fires at 10 s with the notice, and no `error` event arrives (confirms §2.1).
- T4. Pre-roll on a VOD or live channel with ads: measure what `UPDATE_STATE` reports during the ad (state, `currentTime`). Confirm the `ad` inference (§1.4) or record the real signal.
- T5. A mature-flagged channel shows its gate. Confirm that the "click the player" notice appears and that the room isn't paused by the gated client.
- T6. A subscriber-only VOD and a geo-blocked item give error codes 5/6/1 (record the real codes).
- T7. The `UPDATE_STATE` cadence while playing (message count over 30 s) and the drift of the extrapolated `time()` against `getCurrentTime()` after each push.
- T8. Seek latency on a VOD: 10 seeks, median and p95. The seek-only loop settles to ≤ 500 ms spread without oscillating.
- T9. Live pause, then play: every client resumes at the live edge, and the measured spread between two machines is recorded (input for B1).
- T10. Exact CSP sources: zero CSP violations in the console for a whole session.

**Vimeo**
- V1. A public video (e.g. `1084537`, Big Buck Bunny, owner `account_type: "basic"` [probe]) plays under our sandbox and `allow` with the SDK attached, with zero CSP violations.
- V2. A domain-restricted video: record the `ready()` rejection name, or the absence of one (then the timeout path fires).
- V3. The rate probe on a basic-plan video (expect a rejection → seek-only) and on a Starter+ video (expect fine nudges). Measure the effective rate at 1.05 as ADR 0013 did for YouTube.
- V4. An unlisted video via `vimeo.com/<id>/<hash>` and `player.vimeo.com/video/<id>?h=` plays. A private and a password-protected video show the notice.
- V5. Autoplay with sound after "Enter room" in regular Chrome. When blocked, record the rejection name and confirm the muted retry and Unmute button.
- V6. `controls=0` on a basic-plan video: record whether the controls stay (expected) and that in-player clicks become room intents.
- V7. The `timeupdate` cadence and extrapolation error, as in T7.

## 8. Contract proposal (for [OME-122](/OME/issues/OME-122); implement as written)

All server→client changes are additive for YouTube rooms. The client→server `control` change is breaking, which is fine because the web client and server deploy together (ADR 0003: new clients only talk to new servers). The extension only uses `canonicalizeEmbed` and the `Embed` type.

```ts
// embed.ts
export const PROVIDERS = ["youtube", "twitch", "vimeo"] as const;
export type Provider = (typeof PROVIDERS)[number];

// YouTube: unchanged (YoutubeVideoIdSchema, YOUTUBE_EMBED_BASE, RESERVED_IDS).

const TWITCH_PLAYER = "https://player.twitch.tv/";
const TWITCH_RESERVED = new Set(["directory", "videos", "settings", "subscriptions", "inventory", "wallet", "drops",
  "turbo", "prime", "friends", "messages", "search", "downloads", "jobs", "p", "store", "login", "signup", "logout",
  "broadcast", "moderator", "popout", "embed", "following", "u"]);
export const TwitchLoginSchema = v.pipe(v.string(), v.regex(/^[a-z0-9_]{1,25}$/), v.check((s) => !TWITCH_RESERVED.has(s), "reserved"));
export const TwitchVodIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,11}$/));

const VIMEO_PLAYER = "https://player.vimeo.com/video/";
export const VimeoIdSchema = v.pipe(v.string(), v.regex(/^[1-9][0-9]{0,11}$/));
export const VimeoHashSchema = v.pipe(v.string(), v.regex(/^[0-9a-f]{6,32}$/));

/** Every variant's `url` is rebuilt from its ids, so a parsed Embed is safe as an iframe src (ADR 0003). */
export const EmbedSchema = v.variant("provider", [
  v.pipe(
    v.object({ provider: v.literal("youtube"), videoId: YoutubeVideoIdSchema, url: v.string() }),
    v.check((e) => e.url === YOUTUBE_EMBED_BASE + e.videoId, "url is not the canonical embed url"),
  ),
  v.pipe(
    v.variant("kind", [
      v.object({ provider: v.literal("twitch"), kind: v.literal("live"), channel: TwitchLoginSchema, url: v.string() }),
      v.object({ provider: v.literal("twitch"), kind: v.literal("vod"), videoId: TwitchVodIdSchema, url: v.string() }),
    ]),
    v.check((e) => e.url === twitchUrl(e), "url is not the canonical embed url"),
  ),
  v.pipe(
    v.object({ provider: v.literal("vimeo"), videoId: VimeoIdSchema, hash: v.nullable(VimeoHashSchema), url: v.string() }),
    v.check((e) => e.url === vimeoUrl(e.videoId, e.hash), "url is not the canonical embed url"),
  ),
]);
export type Embed = v.InferOutput<typeof EmbedSchema>;

function twitchUrl(e: { kind: "live"; channel: string } | { kind: "vod"; videoId: string }): string {
  return e.kind === "live" ? `${TWITCH_PLAYER}?channel=${e.channel}` : `${TWITCH_PLAYER}?video=v${e.videoId}`;
}
function vimeoUrl(id: string, hash: string | null): string {
  return hash === null ? VIMEO_PLAYER + id : `${VIMEO_PLAYER}${id}?h=${hash}`;
}

/** Longest canonical Embed.url: vimeo id 12 + hash 32 → 70 chars; 128 leaves room. */
export const MAX_EMBED_URL_LENGTH = 128;

/** canonicalizeEmbed(input): unchanged signature. Dispatches on hostname to the §3 extractors; null for anything else. */

// capabilities.ts (new, pure; used by server and web)
export interface PlaybackCaps {
  /** Position can be set (false: Twitch live). */
  readonly seek: boolean;
  /** Live stream: only playing/paused is shared; position is always 0. */
  readonly live: boolean;
  /** "yes" settable; "probe" depends on the video (Vimeo owner plan); "no" never (Twitch). */
  readonly rate: "yes" | "probe" | "no";
}
export function playbackCaps(e: Embed): PlaybackCaps;
// youtube → {seek:true, live:false, rate:"yes"}; vimeo → {seek:true, live:false, rate:"probe"}
// twitch vod → {seek:true, live:false, rate:"no"}; twitch live → {seek:false, live:true, rate:"no"}

// messages.ts: control identifies the embed by its canonical url, not a YouTube id.
v.strictObject({
  type: v.literal("control"),
  url: v.pipe(v.string(), v.maxLength(MAX_EMBED_URL_LENGTH)),
  playing: v.boolean(),
  position: PositionSchema,
}),
// `url` must equal the room's current embed.url, else error no_embed (same code as today).
```

**Server semantics (S1):**
- `applyControl` compares `control.url` with `embed.url`.
- If `playbackCaps(embed).live`, the stored state is `{ playing: control.playing, position: 0, rate: 1, action: playing ? "play" : "pause" }`. The `position` field is ignored, and `seek` is never derived.
- On `load` of a live embed, `position` is 0.
- No new error code. A position sent for a live embed isn't an error, it's just ignored.
- `PlaybackStateSchema`, `RoomStateSchema` and `embed-changed` keep their shapes. Clients derive "live" from `playbackCaps(room.embed)`, not from the wire.

**Size check:** the largest Embed goes from about 70 B to about 110 B (Twitch live with a 25-char login and `kind`/`channel` keys). The snapshot is still far below 16 KB. `control` grows by about 60 B, which is still below 200 B.

**Web (W0):** `tvFrame()` dispatches on `provider`:
- youtube: unchanged.
- vimeo: `url` plus the fixed §2.2 parameters.
- twitch: returns `null` for the iframe, plus a frozen `TwitchPlayerOptions` object: `{ channel } | { video: "v" + id }`, plus `parent: [hostname]`, `autoplay: true`, `muted: false`, `width: "100%"`, `height: "100%"`. The Twitch adapter hands it to `Twitch.Player` and verifies the result (§4.1).

**ADR to write with OME-122 (ADR 0014 "Twitch and Vimeo players"):**
- the accepted kinds;
- the Twitch SDK-built iframe exception to "`tvFrame()` builds every iframe" and its post-render checks;
- Twitch's sandbox deviations;
- the exact-file CSP sources;
- the `control.url` change;
- `playbackCaps` and the `live` mode;
- the per-provider TV minimum (an amendment to ADR 0012).

## Open questions for the board

- **B1. The live spread budget.** "Spread ≤ 500 ms" can't be met or measured on Twitch live: each viewer's HLS latency differs, and we can't seek or change the rate. Proposal: the budget applies to seekable providers only. For live, we only guarantee that pause/play reaches everyone within the 50 ms relay budget. Needs board sign-off because it narrows a merge-blocking budget.
- **B2. The Twitch Developer Services Agreement** (<https://legal.twitch.com/legal/developer-agreement/>). It didn't render without JavaScript, so we haven't reviewed it for rules on shared control or syncing, as with YouTube's RMF question in M1b. Someone with a browser should read it before M2 sign-off. This blocks no engineering.
- **B3. Mature-content and subscriber-only content.** Proposal: we don't try to detect or block them. Gated clients see Twitch's own gate or a notice (T5, T6). Confirm that's acceptable for a shared room.

## Suggested use by the M2 issues

- [OME-122](/OME/issues/OME-122): §8 plus ADR 0014.
- [OME-124](/OME/issues/OME-124): §4.3, §6 and §6.4.
- [OME-125](/OME/issues/OME-125): §1.1, §2.1, §4.1 and T-items as a spike before merge.
- [OME-126](/OME/issues/OME-126): §1.2, §2.2 and V-items.
- [OME-127](/OME/issues/OME-127): §8 server semantics.
- [OME-129](/OME/issues/OME-129): §3 (the extension uses the shared canonicalizer only).
- [OME-121](/OME/issues/OME-121) / [OME-131](/OME/issues/OME-131): §7.1.
- [OME-133](/OME/issues/OME-133): §7.3.
