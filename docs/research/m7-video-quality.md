# M7 research: per-device video quality

OME-545 (M7 plan item R-M7b, plan on OME-538, board request OME-530). Researched 2026-10-09, read-only. Repo refs are `file:line` on `main@35946ee`. Web facts cite a primary URL. **[unverified]** marks claims that no primary source or repo check confirms.

Scope set by the board: each viewer picks quality on their own device. The choice is local, never synced, remembered per device (`localStorage`), and creates no server state.

---

## Summary

- **Only Twitch (live and VOD) and some Vimeo videos can be set from our page.** YouTube removed its quality API in 2019, and the generic tier has no API at all.
- **We hide the provider's own menu on YouTube and Vimeo** (`controls=0`). A "use the player's ⚙ menu" hint would be false there. Twitch's own menu is already visible today.
- **Recommendation:** a small picker that shows only when the adapter reports a non-empty quality list. That means Twitch always, and Vimeo when `getQualities()` resolves non-empty and `setQuality` doesn't reject. Every other case shows nothing: no disabled control and no hint.
- **One real sync risk:** a quality switch on Twitch could emit pause/play or seek that our adapter reads as a member action outside its echo windows. The new `setQuality` must open an echo window like `command()` does. That risk already exists today through Twitch's own menu.
- **No `packages/shared` change, no server change.** Perf cost is negligible, as long as quality is never changed by remounting the iframe.

## Support table

| Provider | List | Get | Set | Change event | Own menu reachable in our embed? | Picker? |
|---|---|---|---|---|---|---|
| YouTube | removed | removed | `setPlaybackQuality` has no effect | `onPlaybackQualityChange` fires (read-only) | No: `controls=0` (`apps/web/src/tv.ts:124`) | **No** |
| Twitch live | `getQualities()` | `getQuality()` | `setQuality(q)` | none documented | Yes, the SDK shows its own controls (`tv.ts:143`) | **Yes** |
| Twitch VOD | same | same | same | none documented | Yes | **Yes** |
| Vimeo | `getQualities()` → `[{label,id,active}]` | `getQuality()` | `setQuality(q)`, Plus/PRO/Business owners only | `qualitychange` `{quality}` | No: `controls=0` (`tv.ts:66`), but probably ignored on free-plan videos **[unverified]** | **Only if the list is non-empty and set doesn't reject** |
| Generic (ADR 0024) | none | none | none | none | Depends on the site; our sandbox (`tv.ts:72`) does not block in-page menus | **No** |

Sources:
- YouTube IFrame API revision history, **October 24, 2019**: "The `getPlaybackQuality`, `setPlaybackQuality`, and `getAvailableQualityLevels` functions are no longer supported." Calls to `setPlaybackQuality` have no effect, and `suggestedQuality` on load/cue is ignored. https://developers.google.com/youtube/iframe_api_revision_history. This confirms the board's belief.
- YouTube `vq` / `hd` URL params are not listed in https://developers.google.com/youtube/player_parameters. Treat them as non-existent.
- Twitch embed reference (one line per method; no live/VOD limit, no "before PLAYING" limit and no documented `auto` value; the only example value is `chunked`): https://dev.twitch.tv/docs/embed/video-and-clips/
- Vimeo player.js README (`setQuality` is "available to Plus, PRO and Business accounts"; `qualitychange` event): https://github.com/vimeo/player.js. The rejection type differs between the README (`TypeError`) and `src/player.js` (`RangeError`), so treat **any** rejection as "unsupported".
- Vimeo `quality` embed URL param (Starter plan and up, not for live events): https://help.vimeo.com/hc/en-us/articles/12426260232977-About-Player-parameters. We won't use it: changing a URL param remounts the iframe and breaks sync.

## Q2. Does a quality change disturb sync?

All three adapters use the same rule for treating a play/pause event as a member's intent:
1. we have issued a command before;
2. the settled state flips between playing and paused;
3. the flip lands outside the echo window after our last command.

- **YouTube.** The quality can't change, so there is nothing to disturb. For the record, buffering (state 3) returns early and never becomes an intent (`apps/web/src/player/youtube.ts:75-91`, early return at `:82`).
- **Vimeo.** `bufferstart`/`bufferend` only set the buffering state (`apps/web/src/player/vimeo.ts:159`). `seeked` is an intent only if the jump is more than `GAP_JUMP_S` = 2 s (`vimeo.ts:15`, `:144-158`). A quality switch keeps the position, so even if it fires `seeked`, the 2 s rule absorbs it **[unverified that it fires at all]**. We don't listen to `qualitychange` today (`vimeo.ts:24`); the picker would add it to `EVENTS` to keep its label in step.
- **Twitch: the one risk.**
  - `settle` (`apps/web/src/player/twitch.ts:160-170`) ignores flips only within `ECHO_WINDOW_MS` after our command, or within `LIVE_RESUME_MS` = 5 s after our own play on live (`:15`, `:167`). On live, `onSeek` returns early.
  - On VOD, `onSeek` ignores seeks only within `SEEK_ECHO_MS` = 5 s of our own seek (`:17`, `:172-180`).
  - If Twitch emits PAUSE→PLAYING or a seek on a quality switch **[unverified; the docs are silent]**, our adapter would send a `control` to the room: a pause/resume for everyone, or a VOD seek.
  - A long VOD rebuffer can also briefly read as "ad" through `inAd` (`:129`, `AD_FROZEN_MS` = 2 s). That only affects the catch-up label (`apps/web/src/controls/catchup.ts:4,28`).
  - **Mitigation for the implementation issue:**
    - `setQuality` stamps a quality-echo time, and both `settle` and `onSeek` ignore events within 5 s of it.
    - Re-read `getQuality()` after the call, since Twitch documents no change event.
    - Write the failing test first: fake player, `setQuality`, then pause/play and seek → no `intent`.
  - The same pause/play can already happen today when a viewer uses Twitch's own gear, and no echo window covers that. Ask QA to check it by hand on a live channel during the implementation issue. If it reproduces, the fix there is a separate bug.
- **Generic.** No adapter and no events (`apps/web/src/controls/generic-tv.ts`), so there is nothing to disturb.

## Q3. Where no API exists: can the provider's menu stay reachable?

- **YouTube: no.** We embed with `controls=0` and `disablekb=1` (`tv.ts:124-125`). Per https://developers.google.com/youtube/player_parameters, with `controls=0` "Player controls do not display", so there is no gear.
  - Turning controls on just to expose the gear would also expose YouTube's play/pause/seek bar and full screen button. Those would then become a second control surface. Not recommended for M7. If the board wants it, it's a product decision for its own ADR.
  - YouTube's own adaptive (auto) quality keeps working either way.
- **Vimeo: no on paid-owner videos** (`controls=0`, `tv.ts:66`). On free-plan videos Vimeo probably ignores `controls=0` (the parameter needs a Starter plan or higher) and shows its UI. That case can't be set by API anyway, so the viewer would be left with Vimeo's own menu **[unverified]**.
- **Twitch: yes.** The SDK options (`tv.ts:143`) have no controls switch, so its settings gear is always there.
- **Generic: depends on the site.** The sandbox `allow-scripts allow-same-origin allow-presentation` (`tv.ts:72`) does not block in-page menus.
- **Nothing of ours covers the iframe.** `.tv iframe` fills its box (`apps/web/src/style.css:68`), and the `pointer-events: none` layers are on the stage, not the TV (`style.css:78,103`; ADR 0012).
- **Inside the full screen wrapper (OME-540):** the chat strip sits *beside* the video (`docs/research/m7-fullscreen-and-popout.md:11-12`), so Twitch's gear stays clickable. Two checks for the full screen implementation issue:
  - In the iPhone CSS fallback, confirm nothing overlays the iframe's bottom-right corner.
  - Our picker must live in the strip/controls area, not over the video.

## Q4. Perf (`docs/perf-budgets.md`)

- **Bundle:** the picker is a `<select>` plus about 1 KB of logic, with no new dependency. That is negligible against the 200 KB initial-JS budget (`docs/perf-budgets.md:7`).
- **Runtime:** `getQualities`/`getQuality` are one postMessage round trip each. Fetch the list once after `ready` (and on Vimeo `qualitychange`), never per tick or per frame. No polling. Main-thread and missed-vsync budgets (`:10-11`) are unaffected.
- **Never change quality by remounting** (a URL param or a new iframe). A remount reloads the player, drops sync and breaks the frame budgets.
- **Bandwidth:** a viewer picking a higher quality costs only their own bandwidth. Our server never carries video.

## Recommended design (for the implementation wave)

1. **Adapter seam.** Add an optional capability to `PlayerAdapter` (`apps/web/src/player/adapter.ts:28-49`): `qualities(): readonly string[]`, `quality(): string | null` and `setQuality(q: string): Promise<boolean>`, plus a `quality` `PlayerEvent`.
   - YouTube and generic return `[]`.
   - Twitch wraps `getQualities`/`setQuality` with the echo window above.
   - Vimeo returns `[]` until `getQualities()` resolves. If `setQuality` rejects, it marks the capability as unsupported and returns `[]` from then on.
   - This is web-only, so there is no contract issue.
2. **UI.** A compact quality `<select>` in the controls row, shown only when `qualities().length > 0`. **Unsupported providers: hide it entirely, with no disabled control and no hint.** On YouTube and Vimeo the hint would point at a menu we hide. On generic it would be a guess. In full screen it goes in the strip, not over the video.
3. **Persistence.** `localStorage` key per provider (`omega.quality.twitch`, `omega.quality.vimeo`). Store the label the viewer chose, e.g. `720p60` or `auto`.
   - On each `ready`, apply it only if it appears in that video's list. Otherwise leave the provider's default.
   - Never send it on the socket. Room state, snapshots and the server stay untouched.
4. **Tests first:**
   - adapter unit tests: echo suppression after `setQuality`, Vimeo rejection → `[]`;
   - a picker state test: hidden when the list is empty, restores the stored label only if listed;
   - one e2e with the fake Twitch SDK.

## Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Twitch emits pause/play or seek on a quality switch **[unverified]** | The whole room pauses or seeks when one viewer changes quality | Quality-echo window in `settle`/`onSeek`; QA checks by hand on live and VOD |
| The same, via Twitch's own gear (exists today) | Same as above | Manual QA repro; separate bug if confirmed |
| Vimeo plan gating; rejection type undocumented (`TypeError` vs `RangeError`) | The picker shows, then fails | Treat any rejection as unsupported and hide |
| Twitch quality labels aren't documented (`chunked`, `720p60`, …) | Stored label invalid on another stream | Apply only when it's in the current list |
| The board expects YouTube support | YouTube is the main provider, and it gets no picker | Say it plainly: YouTube removed the API in 2019 and picks quality automatically. The only workaround (`controls=1`) adds a second control surface; that's a separate ADR if wanted |
| Provider API changes again | The picker breaks silently | Capability is probed at runtime per video, so the failure mode is "hidden" |
