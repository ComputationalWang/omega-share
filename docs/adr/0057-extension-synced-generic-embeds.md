# ADR 0057 — Extension-synced generic embeds (kwik first)

**Status:** proposed (2026-10-29) · question [OME-1962](/OME/issues/OME-1962) · spike and draft [OME-1963](/OME/issues/OME-1963) · amends ADR 0024 §3 and §7 ("a generic embed never carries playback state") and ADR 0047 §5 (bridge) and §4 (store copy) · **needs the board before any implementation, because it reverses the ADR 0024 invariant**

## Context

Kwik shares play in a room for viewers who unlocked kwik (ADR 0047), but they are not synced. A generic embed has no player API we can use across origins: the server keeps `playback: null` for it, and `control` answers `no_embed` (ADR 0024 §7). TwoSeven syncs such hosts with an extension content script that drives the page's `<video>` element directly.

Our extension can do the same, with no new permissions. A viewer who unlocked a host has already granted us `https://<host>/*` (ADR 0047 §1). That grant lets the extension inject a script into that host's frame in the room tab.

### Spike (OME-1963, 2026-10-29)

**Setup:** headed Chromium under the xvfb wrapper (board rule), and a stand-in room page that builds the ADR 0024 §2b iframe (same `sandbox`, `allow`, `referrerpolicy`) on a Load click. A minimal MV3 extension held `https://kwik.cx/*`, set the ADR 0047 §3 Referer rule, and ran a content script (`all_frames`, `document_start`, isolated world) in the kwik frame. The script relayed `chrome.runtime.sendMessage` to the background, and the page sent commands with `postMessage`. Embed: `https://kwik.cx/e/ockxKpNdX2Kh` (the [OME-1039](/OME/issues/OME-1039) episode, still live).

| Question | Result |
|---|---|
| Find the video | `<video id="kwikPlayer">` was found 2 ms after `document_start` through a `MutationObserver`. `loadedmetadata` gave `duration` 1370 s and a `blob:` source (hls.js MSE) |
| `play()` | Resolves. `play`/`playing` fire, unmuted (`muted: false`) |
| Seek | `currentTime = 300` and `= 30` both give `waiting` → `seeked` → `playing` in under 2.5 s, and playback continues from the new spot |
| Pause / rate | `pause()` takes effect at once. `playbackRate = 1.5` sticks, survives a later play, and fires `ratechange` |
| `currentTime` while playing | 5 samples taken 2 s apart differ by 2.000–2.006 s each. The clock is steady and readable at any time |
| Relay identity | Every message reaches the background with `sender.frameId`, `sender.origin = "https://kwik.cx"` and `sender.tab`, so the background knows which tab and frame spoke |
| Nested frames | kwik builds **3 kwik-origin frames**. Only the top embed frame has a `<video>`; the other two load the script and stay quiet. No third-party frames |
| Ads / pre-rolls | **None in the embed.** It loads hls.js, jQuery, Plyr and its capture plugin and `/app/js/downstream.js`, with no VAST/IMA and no ad iframe. kwik's ads live on the partner page, which we never frame |
| Main world | kwik's own scripts see the same `<video>`, can change it, and can `postMessage` our room page directly (see Safety) |
| Autoplay without a gesture | A Load fired by script, not a click, still played unmuted. This is not a reliable result: the Playwright-launched Chromium may score autoplay differently from a real profile. In the product every viewer clicks Load anyway (ADR 0024 §3). The adapter still handles `NotAllowedError` with the existing `autoplay-blocked` event |
| Firefox | Not run. Checking it is part of the QA issue below |

**Verdict:** a content script in the unlocked frame can read and drive kwik's video reliably. kwik is the easy case: one `<video>`, no in-frame ads and no third-party frames.

## Decision (proposed)

### 1. Contract: playback for every generic embed

- **The server keeps playback for a generic embed exactly as it does for a synced one.** `playbackMatchesEmbed` becomes "playback is null iff embed is null". This is server state and costs the server nothing. The server can't know who has the extension, and it doesn't need to.
- The issue suggested giving a generic embed playback only "when the sharer has the extension". **Rejected:** the server can't verify that. The sharer isn't special either, since every viewer syncs their own frame. Who can sync depends on each viewer, not on the share.
- `playbackCaps` for a generic embed is `{ seek: true, live: false, rate: "yes" }`, because `HTMLMediaElement` accepts the room's rates. Live generic streams (`duration === Infinity`) are detected on the client and treated like Twitch live there (play/pause only). The server's caps stay static.
- `control.url` is capped at `MAX_GENERIC_EMBED_URL_LENGTH` (1024) instead of `MAX_EMBED_URL_LENGTH` (128) when the current embed is generic. In the schema that means a 1024 cap with an equality check, and the server compares the URL to the current embed as it does today. `control` on a generic embed no longer answers `no_embed`.
- **`ended` stays ignored for generic embeds** (unchanged). A page we don't vet must not be able to advance the room's queue. Manual next stays the way past a generic item.
- The Rust mirror (`contract/state.rs`, `server_message.rs`, `room.rs` `restored_playback`), the comparison corpus and the black-box manifest change in the same contract issue.

### 2. Viewers without the extension

Nothing changes for them. They see the ADR 0024 card and play the frame on their own, and their UI still says "not synced". The hint changes to "Synced for viewers with the Omega Share extension". Their own clicks inside the frame don't reach the room, because we can't see them.

### 3. Extension: one injected frame script, room tab only

- **No registered content script and no `matches` on the host.** After `unlock-result: unlocked` and the web's iframe `load`, the web asks the bridge to `attach { host }`. The background then runs `scripting.executeScript({ target: { tabId, allFrames: true }, files: ["frame-sync.js"] })` on **the room tab only**. Chromium and Firefox inject only into frames whose origin we hold host access for: our page and the unlocked host. The script exits at once unless `window !== top` and `location.hostname === host`. So kwik.cx opened as a tab of its own never gets our script.
- The script attaches to the first `<video>` in its frame, using a `MutationObserver` until one appears and re-attaching on `emptied`/element swap. It reports only from a frame that has a video. When more than one frame reports, the background keeps the first `frameId` and ignores the rest (kwik: one).
- **Relay, both ways through the background, never `postMessage` between frame and page:**
  - page → `frame-command { host, op: "play" | "pause" | "seek" | "rate" | "volume" | "unmute", value? }` → bridge → background → `tabs.sendMessage(tabId, cmd, { frameId })`.
  - frame → `runtime.sendMessage` → background → bridge (`frameId: 0`) → page: `frame-state { host, state, position, rate, duration, muted }` on every media event and once a second while playing; `frame-intent { host, playing, position }` (§5); `frame-lost { host }`.
- `relock`, a tab navigation and an embed change detach the script (it removes its listeners) along with the ADR 0047 rules.
- **Permissions delta: none.** `scripting` is held already (ADR 0005), and host access is the viewer's own ADR 0047 grant. There is no new install-time or optional entry, and the store-manifest guard doesn't change.
- **Store disclosure delta:** the Unlock text adds "While that host plays in a room, the extension also plays, pauses and seeks its video so everyone watches together." The CWS `scripting` justification adds "inject a small script into a video host's frame inside the user's room tab, only for hosts the user unlocked". `data_collection_permissions` don't change: positions already go to our server as `control`.

### 4. Web: one more adapter

`apps/web/src/player/frame.ts` implements `PlayerAdapter` over the bridge. It is lazily imported like the other adapters, and only for a generic embed after `attach` succeeds. `time()` extrapolates from the last `frame-state` (`position + rate × elapsed` while playing), the same model the sync loop already uses. When the script doesn't attach within 5 s, the frame stays unsynced as today and the card reads "can't sync this host". The sync controls appear for a generic embed only while an adapter is attached.

### 5. Safety

- **Everything from the frame is untrusted.** kwik's main world shares the DOM: it can swap the `<video>`, fake its state, and fire events. The background parses every frame message with Valibot: finite numbers, `position` 0…`MAX_POSITION`, `rate` in the room's list, `host` equal to the tab's unlocked host. It also requires `sender.tab.id` to have a live unlock set for that host, `sender.origin === "https://<host>"` and `sender.frameId !== 0`. The page parses it again at its own `message` listener (`event.source === window`, `event.origin` ours), as in ADR 0047 §5.
- **A page posting straight to our window gets nothing.** The web takes frame data only from bridge messages, which come from our own window on our origin. A `postMessage` from the kwik frame has `event.source` set to the frame and is dropped.
- **A host page can't drive the room by faking events.** A `frame-intent` (a user's play/pause/seek inside the frame, which becomes a room `control`) is sent only while the frame has `navigator.userActivation.isActive`. Script can't fake that: a real click or key press inside the frame is needed. Our own commands are tagged and their echoes suppressed, as in the other adapters. The control rate limits (ADR 0016/0018) still cap what a viewer can send. A hostile host can still lie to **its own viewer's** adapter about position. The cost is that one viewer drifting, which the server-side clock and the other viewers ignore.
- The frame script never reads anything but the `<video>` element's media state. It sends no page content and no URL other than `host`, and it logs nothing.
- The ADR 0024 sandbox and the ADR 0047 rule scope are unchanged.

### 6. Performance

- Rooms without a generic embed, and viewers without the extension, pay nothing new: no listener, no script.
- With it, the cost is one injected script in one frame (well under 2 KB), one media-event listener set, and 1 `frame-state` per second plus one per event, each crossing 3 hops (runtime messages about 1 ms each on localhost). That is negligible next to the 8 ms frame budget, and it adds nothing to the frame loop: the adapter stores the last state and `time()` is arithmetic.
- Sync spread (≤ 500 ms) is expected to hold. Seeks settled in under 2.5 s in the spike, the same order as YouTube. QA measures the spread for a generic embed with two extension viewers.
- The `docs/perf-budgets.md` row "Content scripts on page load" gains: "…and, in a room tab with an unlocked generic host, one injected frame script in that host's frame". No budget value moves. The web bundle gains one lazily loaded adapter chunk (about 1–2 KB gz), outside the initial JS.

## Consequences

- ADR 0024's invariant "a generic embed never carries playback state" ends. A generic room now has a room clock, and viewers with the extension follow it.
- Mixed rooms are normal: extension viewers stay in sync, and the others watch on their own as today. The UI says which applies to whom.
- Accepted losses: hosts whose `<video>` sits in a third-party nested frame (we hold only the unlocked host), in a closed shadow root, or in canvas/EME players; in-player ads on hosts other than kwik (v1 doesn't detect them, so an ad can briefly count as the room's video); and auto-advance at the end of a generic item.
- Rollback: the web stops attaching the adapter, and the server's playback for generic embeds is then harmless state.

## Work (estimates; contract first, blocks the rest)

1. **Contract** (Lead, ~0.5 d): `playbackMatchesEmbed`, generic `playbackCaps`, `control.url` cap, bridge schemas (`attach`, `frame-command`, `frame-state`, `frame-intent`, `frame-lost`), the Rust mirror and regenerated corpus.
2. **server-rs** (~0.5 d, after 1): playback for generic embeds on share, restore and queue advance, `control` accepted, `ended` still ignored, plus black-box manifest rows.
3. **Extension** (~2 d, after 1, in parallel with 4): `frame-sync.js`, background attach/relay/detach with the sender checks, user-activation-gated intents, unit tests with fakes, STORE.md/CWS/AMO copy.
4. **Web** (~1.5 d, after 1): `player/frame.ts`, mount wiring and attach timeout, card hint and per-viewer "synced/not synced" label, unit tests.
5. **QA** (~1 d, after 2–4): an e2e lane on the existing `xfo.omega-fixture.net` fixture with a local `<video>` (deterministic), a real-provider kwik spec under xvfb (two extension viewers: play/pause/seek spread ≤ 500 ms; a third without the extension stays unsynced), Firefox, and the generic perf rows rechecked.

About 5.5 engineer-days in total.
