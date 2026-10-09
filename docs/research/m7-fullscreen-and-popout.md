# M7 research: full screen with a chat strip, and pop-out chat

OME-540 (M7 plan item R-M7a, plan on OME-538). Researched 2026-10-09, read-only. Repo facts are `file:line` on `main@854fb49`. Web facts cite a primary URL. **[unverified]** marks claims no primary source or repo check confirms. The caniuse Android rows looked odd when fetched, so treat them with care.

Feeds the M7 full-screen and pop-out waves (filed after M6 approval).

---

## Summary

- **Full screen goes on our own wrapper** (video + chat strip), never on the provider iframe. Nothing is reparented, so the iframe does not reload and postMessage sync keeps running.
- **The chat strip sits beside the video, not over it.** ADR 0012 forbids covering the player (`docs/adr/0012-tv-outside-the-scaled-stage.md:12`), and a flex row costs no extra compositing.
- **Pop-out: same-origin `window.open` + `BroadcastChannel`, chat only.** The main tab keeps the one WebSocket and relays. No second Pixi renderer, no second `join`.
- **No `packages/shared` change** for any of it.
- **We have no chat log today.** Chat is a one-line input (`apps/web/src/room.ts:221-233`) plus speech bubbles over avatars (`room.ts:672-681`). The strip and the pop-out both need a new, capped message list. That is a feature with its own issue, not a toggle.

| Platform | Full screen | Pop-out |
|---|---|---|
| Desktop Chromium | `requestFullscreen()` on the wrapper | `window.open` + `BroadcastChannel` (Document PiP is an optional later extra) |
| Android Chrome | `requestFullscreen()` on the wrapper, then `screen.orientation.lock("landscape")` | Hidden (no second monitor) |
| iPhone Safari | CSS full-viewport fallback (no element full screen) | Hidden |
| iPad Safari | Try `requestFullscreen` / `webkitRequestFullscreen`, CSS fallback on reject | Hidden |

---

## Q1. Full screen on our wrapper vs the provider iframe

**Wrapper wins.** Only the wrapper can hold the chat strip. `Element.requestFullscreen()` works on elements of a top-level document, or inside an `<iframe allowfullscreen>` ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen)). Our wrapper is top-level. Our `Permissions-Policy` does not restrict `fullscreen` (`apps/server/src/headers.ts:39-51`), so no header change is needed.

Exit comes from Esc, the browser UI or Android Back, not only our button. Detect it with `fullscreenchange` and `document.fullscreenElement === null`, and drive the layout from that event.

**Support:**
- Chrome 71+, Edge 79+: full. Android Chrome: full ([caniuse](https://caniuse.com/fullscreen)).
- Safari 16.4+ on macOS: full, unprefixed. iOS Safari is *partial* through 27.x (same page).
- **iPhone:** no full screen for non-video elements. WebKit bug 212934 is RESOLVED WONTFIX, with a January 2026 comment "We probably don't want to be adding new capabilities to webkitFullscreen" ([WebKit 212934](https://www2.webkit.org/show_bug.cgi?id=212934)). A Safari 17.2 beta flag came and went ([Apple forums](https://developer.apple.com/forums/thread/133248?page=2)). Treat it as unavailable.
- **iPad:** unprefixed `requestFullscreen` from Safari 16.4 per the same thread; the Safari 26.0 / 26.4 notes only list fixes ([26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/), [26.4](https://webkit.org/blog/17862/webkit-features-for-safari-26-4/)). **[unverified]** on real iPad hardware.

**Fallback (iPhone, or whenever `requestFullscreen` is missing or rejects):**
- A `.pseudo-fs` class on the wrapper: `position: fixed; inset: 0; height: 100dvh; padding: env(safe-area-inset-*)`.
- `env(safe-area-inset-*)` needs `viewport-fit=cover`. Our viewport meta lacks it today (`apps/web/index.html:5`), so that is a one-line change, checked against the normal layout.
- Safari's toolbar stays. Only an installed web app (`display: standalone` manifest) hides it. We have no manifest; adding one is a separate decision.
- Exit: our button, plus one `history.pushState` entry on enter and exit on `popstate`, so the Back gesture leaves the mode instead of the room.

**Orientation lock:** `screen.orientation.lock()` works "typically ... on mobile devices, and when the browser context is full screen" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock)). Call it only after real full screen succeeds (Android), inside try/catch, and ignore rejection. iOS Safari does not support it **[unverified]**; the CSS mode follows the device rotation instead.

## Q2. YouTube, Twitch, Vimeo when the parent goes full screen

**Mounting.** `tv` is built once as a child of `wrap` (`room.ts:199-202`). YouTube and Vimeo adapters attach to the iframe `tv.ts` builds (`apps/web/src/player/youtube.ts:203-209`); Twitch renders into a box (`player/twitch.ts:325-343`). Full screen on an ancestor moves no node, so nothing reloads and sync keeps working. Moving the iframe to another parent **would** reload it, so the full-screen wrapper must be an existing ancestor of `tv`, not a new container we move it into.

**`wrap` is not the right element as-is.** It also holds the controls and the Pixi stage `clip` (`room.ts:202`). In full screen:
- hide `clip` and stop the Pixi ticker (a hidden canvas still costs rAF work);
- give `fit()` a full-screen branch. Today it sets absolute rects from `roomLayout(wrap.clientWidth, …)` (`room.ts:299-310`, `apps/web/src/layout.ts`). In full screen `tv` fills the area minus the strip. The ADR 0012 player minimum still holds.
- the chat strip must be inside the full-screen element, so it moves into (or is created in) `wrap`; today `chatForm` is a sibling of `wrap` (`room.ts:203`).

**Provider full-screen buttons.**
- YouTube: `controls=0` already (`apps/web/src/tv.ts:124`), so no button. `fs=0` would be redundant ([player params](https://developers.google.com/youtube/player_parameters)).
- Vimeo: `controls=0` in `VIMEO_PARAMS` (`tv.ts:61-70`), no chrome.
- Twitch: no documented option to hide controls ([Twitch embed](https://dev.twitch.tv/docs/embed/video-and-clips/)), so its button stays visible.
- If a viewer presses a provider button while we are in full screen, the iframe requests nested full screen (allowed because `allow` contains `fullscreen`, `tv.ts:58-59,74`). Our strip is hidden while that lasts. Whether Esc then returns to our wrapper or exits fully was **[unverified]**; checked in OME-597 (below).
- **Verified 2026-10-09 (OME-597), headed Chromium (Playwright's bundled build) under Xvfb, with a real X key press (`xdotool key Escape`; an automated CDP key press never reaches the browser's own Esc handling):** our wrapper in full screen, then a nested `allow="fullscreen"` iframe calling `requestFullscreen()` from a click (what Twitch's own button does inside its iframe). One Esc **fully exits**: one `fullscreenchange` with `document.fullscreenElement === null`, both levels gone, and the page gets no `keydown`. Esc with only our wrapper in full screen does the same. This is the Fullscreen spec's "fully exit fullscreen" on a user exit. So after a provider's nested full screen, Esc leaves our full screen too; `fullscreen.ts` follows `fullscreenchange` and lays the room page back out. While the nested level lasts, `document.fullscreenElement` is the iframe, and our mode stays on underneath. The real Twitch button couldn't be pressed in this run: the channels tried were offline, so the player showed no controls.

**Recommendation: keep `allow="fullscreen"`.** It is harmless for YouTube and Vimeo, Twitch's own button needs it, and ADR 0024 keeps it for the generic tier ("Fullscreen is the basic viewing need"). Removing it would also change the exact-match tests (`apps/web/test/tv.test.ts:57,145,216`) for no gain. A generic embed under our wrapper gets our full screen too.

## Q3. Pop-out options

| Option | Support | Verdict |
|---|---|---|
| (a) `window.open` + `BroadcastChannel` | All desktop browsers ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)) | **Recommended** |
| (b) SharedWorker owns the WebSocket | Android Chrome only since 148 ([release notes](https://developer.chrome.com/release-notes/148)) | Rejected: rewrites `browserSocket` (`room.ts:93`) and `connection.ts` for no user-visible gain |
| (c) Document Picture-in-Picture | Chrome / Edge 116+, Firefox 151, no Safari ([Chrome docs](https://developer.chrome.com/docs/web-platform/document-picture-in-picture)) | Optional later extra, chat only |

**(a) in detail:**
- The main tab owns the single socket; the pop-out is a view and never joins. One WebSocket per user holds.
- **CSP** (`apps/server/src/headers.ts:12-28`): the pop-out is a same-origin page, so `script-src 'self'`, `connect-src 'self'`, `style-src 'self'` all pass. `frame-ancestors 'none'` blocks framing, not `window.open`. Trusted Types is enforced, so the pop-out builds DOM with `textContent` as the room does.
- **COOP `same-origin`** (`headers.ts:62`): open with `noopener`. `window.opener` is then null and the pop-out may land in a new browsing context group, but `BroadcastChannel` is per origin (and storage partition), so it still connects. We never hold a window reference, which keeps the two sides decoupled.
- **Token:** the share token lives in per-tab `sessionStorage` (`apps/web/src/share-token.ts:4-17`, `room.ts:794`). A `noopener` pop-out has none, so it must not need one: it receives chat over the channel and sends typed chat back over the channel; the main tab calls `c.send` with its own rate limit.
- Channel payloads are a boundary: parse them with Valibot on receipt, like wire frames.
- A **whole-room** pop-out needs a second Pixi renderer and either a second socket or a state mirror. Not recommended for M7.

**(c) in detail:**
- One PiP window per tab, opened from a user gesture, always on top, position not settable, closes with the opener ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API)).
- Live DOM nodes can be moved in (`pipWindow.document.body.append(node)`) and back; stylesheets must be copied by hand. The chat log can move; the video iframe must not (it would reload).
- How our CSP and Trusted Types apply inside the PiP document is **[unverified]**.

**Background-tab throttling and sync:**
- Hidden tabs clamp timers to once per second. Chrome's intensive throttling (once per minute) needs all of: hidden over 5 min, timer chain ≥ 5, page silent for 30 s, no WebRTC ([Chrome 88 blog](https://developer.chrome.com/blog/timer-throttling-in-chrome-88)). A playing video with sound is not silent, so the main tab should be exempt while it plays; a muted or paused video is not **[unverified]** for audio inside a cross-origin iframe.
- Our sync loop is `setInterval(tick, 250)` (`apps/web/src/sync.ts:5,449`). Hidden, it drops to 1 s ticks; WebSocket messages still arrive and `room.ts` already runs `syncTv` from dispatch because rAF stops in background tabs.
- `clock.ts:131-134` resyncs only on `visibilitychange` → visible. Focusing the pop-out does not make the main tab visible.
- Whether a window fully covered by the pop-out counts as hidden is OS-dependent **[unverified]**. Test: main tab behind a maximised pop-out for over 5 min while playing.
- Mitigation: accept 1 s correction while hidden and rely on seek-on-resync; do not add a Worker timer.

## Q4. Perf risk per option (`docs/perf-budgets.md`)

| Option | Frame / main thread | Bundle (200 KB gz) | Heap (150 MB) | WS |
|---|---|---|---|---|
| Full screen, strip beside video | Lower: Pixi ticker paused | ~1-2 KB | Message list capped (~50 nodes) | none |
| `window.open` chat-only | No second Pixi; DOM list only | ~1 KB + small entry chunk | One small extra JS context | none (channel is local) |
| SharedWorker | Socket off main thread | Worker chunk | Extra worker | Socket layer rewrite |
| Document PiP | As chat-only | Small | Small | none |

- No strip overlaid on the video (compositing + ADR 0012). No `backdrop-filter`. Fade with a CSS `opacity` / `transform` animation, not a JS timer per message.
- Budgets are measured with "8 avatars + video playing". Add a full-screen row per provider to `perf/polish.perf.ts` so a regression blocks the merge.

## Q5. Contract change

None. The wire union already carries `chat` both ways (`packages/shared/src/messages.ts:74,186`). The pop-out channel carries local, already-parsed view data, never new wire frames. Its message schema lives in `apps/web`, not `packages/shared`, because it never crosses the network.

## Where it touches our code

- `apps/web/src/room.ts:199-203,299-310`: wrapper, `fit()`, resize observer; chat form placement.
- `apps/web/src/room.ts:221-233,672-681`: chat input and bubbles; the chat log is new.
- `apps/web/src/layout.ts`: full-screen layout branch.
- `apps/web/src/tv.ts:58-74`: `allow` strings (keep as is).
- `apps/web/src/player/*.ts`: no change.
- `apps/web/src/style.css`: new `.pseudo-fs` and full-screen rules (`.tv` rules at 65-72).
- `apps/web/index.html:5`: add `viewport-fit=cover`.
- `apps/web/src/sync.ts:449`, `apps/web/src/clock.ts:131-134`: timers and visibility (no change expected).
- `apps/server/src/headers.ts:12-28,39-51,62`: CSP, Permissions-Policy, COOP; no change needed.

## Risks

1. The chat log is new UI with a cap, accessibility (ARIA live, plan item 4) and tests; it is the bulk of the work.
2. iPhone gets no true full screen; the Safari toolbar stays visible.
3. Provider-button nested full screen hides our strip; exit behaviour unverified.
4. Main tab hidden behind the pop-out: 1 s timer ticks, possibly 1 per minute if the video is muted or paused.
5. `noopener` pop-out has no share token, so it stays view-and-chat only, relayed through the main tab.
6. Two pop-outs (or a reopened one) could double-send chat; the main tab de-duplicates and allows one pop-out per tab.
7. A careless full-screen `fit()` branch can break the ADR 0012 player minimum.
8. iPad behaviour and Document PiP CSP behaviour need a device / browser check before shipping.

## Sources

- https://developer.mozilla.org/en-US/docs/Web/API/Element/requestFullscreen
- https://caniuse.com/fullscreen
- https://www2.webkit.org/show_bug.cgi?id=212934
- https://developer.apple.com/forums/thread/133248?page=2
- https://webkit.org/blog/17333/webkit-features-in-safari-26-0/
- https://webkit.org/blog/17862/webkit-features-for-safari-26-4/
- https://developer.mozilla.org/en-US/docs/Web/API/ScreenOrientation/lock
- https://developers.google.com/youtube/player_parameters
- https://dev.twitch.tv/docs/embed/video-and-clips/
- https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel
- https://developer.chrome.com/release-notes/148
- https://developer.chrome.com/docs/web-platform/document-picture-in-picture
- https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API
- https://developer.chrome.com/blog/timer-throttling-in-chrome-88
