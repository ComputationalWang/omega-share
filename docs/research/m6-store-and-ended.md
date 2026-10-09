# M6 research: Chrome Web Store readiness and "ended" detection per provider

OME-501 (M6 plan item R1). Researched 2026-10-09. Store facts come from developer.chrome.com only. Provider facts come from the provider's own docs. Repo facts are given as `file:line`. **[inferred]** marks claims no primary source states.

Feeds **C2** (queue contract) and **X1** (store submission).

---

## Part A: Chrome Web Store

### A1. What the extension does today (repo facts)

- **Manifest** (`apps/extension/wxt.config.ts:10-25`):
  - `permissions`: `activeTab`, `scripting`, `storage`.
  - `host_permissions`: the default server origin only. Today that is `http://localhost:8787/*` (`src/settings.ts:4`).
  - `optional_host_permissions`: `http://*/*` and `https://*/*`.
  - The extension-page CSP is pinned.
  - The description is 52 characters, under the 132 limit.
- **e2e-only host permissions** (`http://localhost/*`, `https://www.youtube.com/*`) are added only when `mode === "e2e"`. They are built to `.output/chrome-mv3-e2e`. The production build `.output/chrome-mv3/manifest.json` was checked and contains only `http://localhost:8787/*`. The store zip must come from `.output/chrome-mv3` only (ADR 0005).
- **No remote code.** `src/` has no `eval`, `new Function`, `importScripts`, remote `<script>`, analytics or telemetry.
  - The injected scan (`collectCandidateUrls`, `src/scan.ts`) is a bundled function passed as `func`.
  - Network use is `fetch` to the user's chosen server only: `src/share.ts:29`, `src/rooms.ts:34` and `entrypoints/popup/main.ts:122,157`. Responses are parsed with Valibot.
- **Data the extension handles:**
  - It reads the page URL and the `src`/`data` URLs of iframe, embed, object and video elements on the active tab.
  - It reads the room share token (`sessionStorage["omega.share"]`) from open room tabs of the chosen server.
  - It POSTs the selected embed URL to the server with that token as a bearer token. Cookies are included.
  - It stores `serverBaseUrl` in `chrome.storage.local`.
- **No icons.** The repo has no `apps/extension/public/` directory and the config has no `icons` key. The built manifest has no `icons` entry.
- **Privacy page:** `apps/web/privacy.html` (OME-411) exists but does not mention the extension.

### A2. Policies that apply

| Policy | What it requires | Source | Our position |
|---|---|---|---|
| Single purpose / minimum functionality | A "single purpose that is narrow and easy to understand". An extension that only links to an external service is not enough (Yellow Lithium, Yellow Potassium). | [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies), [troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting) | OK. The extension does real work: it scans the page and shares the embed. The statement is below. |
| Privacy policy | Required if the extension handles user data. It must say what is collected, how it is used and who it is shared with. It must be linked in the dashboard (Purple Lithium). | [privacy](https://developer.chrome.com/docs/webstore/program-policies/privacy) | **Gap.** We handle website content and a token. The policy must get an extension section. |
| Privacy-practices tab | Data-category checkboxes, Limited Use certifications and the policy URL. They must match the policy (Purple Nickel). | [dashboard privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) | To fill in. See A3. |
| Limited Use | Use data only for the single purpose. No ads or selling. No human reading except with consent, for security or law, or anonymised. | [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) | OK. Certify all three statements. |
| Remote hosted code (MV3) | No external scripts, no `eval` of fetched strings, no remote interpreters. Fetching data is allowed (Blue Argon). | [MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) | OK. Answer "No, I am not using remote code". |
| Narrowest permissions | "Request access to the narrowest permissions necessary". Unused permissions are Purple Potassium. | [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies) | **Gap.** `http://*/*` in `optional_host_permissions` can never be granted: `parseServerBaseUrl` allows `http:` only on loopback (`src/settings.ts:33`). |
| Broad host permissions slow review | Broad patterns (`*://*/*`, `<all_urls>`) may cause an in-depth review. | [review process](https://developer.chrome.com/docs/webstore/review-process) | Risk. The page does not say whether *optional* patterns count. Optional host permissions show no install warning and are granted at runtime ([declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions), which uses `https://*/*` as its optional example). Expect possible extra review time; the justification below covers it. |
| Insecure transmission | User data must go over a secure connection (Purple Copper). | [troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting) | **Gap.** The default server is `http://localhost:8787`. The default must become the hosted https origin. |
| Works as described | The reviewer must be able to use the extension (Yellow Magnesium). | [troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting) | **Gap.** A localhost default is dead for reviewers. Point the default at the hosted origin and add test instructions (a public room). |
| Listing info | The listing needs an icon, a description and screenshots (Yellow Zinc). | [troubleshooting](https://developer.chrome.com/docs/webstore/troubleshooting), [prepare](https://developer.chrome.com/docs/webstore/prepare) | **Gap** for manifest icons. Listing assets are OK (A4). |

**Single-purpose statement (draft):**
> Finds a video embed on the page you are viewing and shares it into an omega-share watch room, where everyone in the room watches it in sync.

### A3. Privacy-practices form (draft answers)

**Permission justifications:**

- **activeTab:** "When you open the popup on a page, this lets the extension read that one tab to find its video embeds. No other tab is touched. Access ends when you leave the page." ([activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab): temporary, given on a user gesture, no install warning.)
- **scripting:** "Used with activeTab to run one read-only function bundled in the extension. It lists the page's video embed URLs. It is also used to read the room share token from your open room tabs on your chosen server. No remote code."
- **storage:** "Saves the server address you enter on the options page."
- **Host permission (default server `https://<PUBLIC_ORIGIN>/*`):** "Lets the popup call the omega-share server's share and room-list endpoints. This is the only site the extension contacts by default."
- **optional_host_permissions (`https://*/*` plus loopback):** "You can point the extension at a self-hosted omega-share server on any domain. The extension asks for that one origin at runtime, only after you save it in the options page. Nothing is granted at install. The old origin is removed when you change servers."

**Data categories (tick these):**

- **Website content.** The extension reads embed URLs found on the page.
- **Web browsing activity.** The shared URL leaves the device. The user triggers this, but disclosing it is the safe reading.
- **Authentication information.** The room share token is sent as a bearer token. This is debatable; ticking it is the safe choice.

Do **not** tick personally identifiable information, health, financial, personal communications, location or user activity. The form asks about the extension's data, not the web app's chat.

**Certifications:** tick all three Limited Use statements.

**Remote code:** No.

**Privacy policy URL:** `https://<PUBLIC_ORIGIN>/privacy.html`, after its extension section is added (X1).

### A4. Listing assets vs `assets/store/`

Sizes are from [images](https://developer.chrome.com/docs/webstore/images) and [dashboard listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing).

| Asset | Requirement | `assets/store/` | Status |
|---|---|---|---|
| Store icon | 128×128 PNG, 96×96 artwork with about 16 px transparent padding | `icon-128.png` 128×128 | OK on size. **Padding not verified**; check by eye in X1. |
| Small promo tile | 440×280, required | `promo-440x280.png` 440×280 | OK |
| Screenshots | 1 to 5 images, 1280×800 (or 640×400) | `screenshot-1-room.png`, `screenshot-2-share.png`, both 1280×800 | OK |
| Marquee | 1400×560, optional | none | Optional; skip |
| Manifest icons | 128 required; 16, 32 and 48 recommended ([icons](https://developer.chrome.com/docs/extensions/reference/manifest/icons)) | `icon-16/32/48/128.png` exist | **Not wired into the build.** |

### A5. Verdict: would the current manifest pass?

**No.** It would likely be rejected for these reasons:

1. No manifest icons (Yellow Zinc).
2. A localhost http default that reviewers cannot use (Yellow Magnesium, Purple Copper).
3. An unusable `http://*/*` optional host permission (Purple Potassium).
4. A privacy policy that does not cover the extension (Purple Lithium).

**Changes for X1:**

1. **Icons:** copy `assets/store/icon-{16,32,48,128}.png` to `apps/extension/public/icon/{16,32,48,128}.png`. WXT discovers icons from `public/icon/` **[inferred from WXT conventions; verify in the built manifest]**. Otherwise set `icons` explicitly in `wxt.config.ts`.
2. **Default server:** set `DEFAULT_SERVER_BASE_URL` (`src/settings.ts:4`) to the hosted https origin (`PUBLIC_ORIGIN`). `host_permissions` follows it automatically through `hostPermissionPattern`. For local development, make the default a build-mode switch (the dev and e2e builds keep localhost).
3. **`optional_host_permissions`:** use `["https://*/*", "http://localhost/*", "http://127.0.0.1/*"]` (and `http://[::1]/*` if WXT/Chrome accept it). This matches `parseServerBaseUrl`. Drop `http://*/*`.
4. **Version:** set it from `apps/extension/package.json` (`0.1.0`), or bump to `1.0.0` for the first store release.
5. **`homepage_url`:** set it to the hosted origin. This is optional.
6. **Keep:** the description (52 characters), the CSP and the three permissions. All three permissions are used.
7. **Privacy policy:** add an "Extension" section to `apps/web/privacy.html` covering:
   - what is read: page and embed URLs on the active tab when you open the popup, and the room share token from your room tabs.
   - where it goes: the configured server only.
   - what is stored: the server address, locally.
   - that the data is not sold or used for ads.
8. **Packaging guard:** add a check (script or test) that the zip built from `.output/chrome-mv3` has no `youtube.com` or wildcard-http host permission. This stops the e2e build from ever shipping.
9. **Reviewer notes:** give a public test room URL and the steps "open a YouTube video page → click the icon → pick a room → Share".

---

## Part B: "ended" detection per provider

### B1. What we have today

- **Adapters already emit `{type: "state", state: "ended"}`.** `PlayerState` is defined at `apps/web/src/player/adapter.ts:4`.
  - **YouTube** maps state `0` to ended (`youtube.ts:19`). It already detects ads by `getVideoData().video_id !== videoId`, or by a duration mismatch (`youtube.ts:118,141`).
  - **Twitch** subscribes to `ended`, `online` and `offline` (`twitch.ts:34`). It emits ended only when the channel is not offline (`twitch.ts:203-205`). VOD ads are inferred when the player says Playing but the clock is frozen (`twitch.ts:18,129`).
  - **Vimeo** subscribes to `ended` (`vimeo.ts:24,137`).
- **Nothing reports ended upward.** The sync loop treats `ended` as a no-op (`apps/web/src/sync.ts:127`).
- **The wire contract has no queue yet.**
  - Client messages (`packages/shared/src/messages.ts:62-96`): join, leave, sit, chat, ping, control, status, layout-set, title-set, emote.
  - Playback (`packages/shared/src/playback.ts:23-37`): `{playing, position, rate, at, rev, action, by}`. `rev` goes up by 1 per accepted change.
  - `control` is rejected with `no_embed` on generic embeds (ADR 0024). The server ignores `position` for live embeds.

### B2. Per provider

| Provider | End signal | False positives / edge cases | Recommendation |
|---|---|---|---|
| **YouTube** (IFrame API) | `onStateChange` with data `0` (ENDED). [API reference](https://developers.google.com/youtube/iframe_api_reference) | **Ads:** the API does not document whether ads emit state 0 (`docs/research/m1b-youtube-sync.md:76`). An ad has a different `video_id` and duration, so our `inAd()` filters it. **Seek to end:** fires 0, the same as a natural end. **End screen:** since 2018, `rel=0` limits suggestions to the same channel; it does not remove them ([player parameters](https://developers.google.com/youtube/player_parameters)). A click on a suggestion changes `video_id`. **Loop:** `loop=1` replays; we don't set it. | Report ended only when the state is 0, `!inAd()`, and `getVideoData().video_id` equals the room's video id. |
| **Twitch VOD** (embed `Twitch.Player`) | `Twitch.Player.ENDED` ("Video or stream ends"). `getEnded()` is also available. [Twitch embed docs](https://dev.twitch.tv/docs/embed/video-and-clips/) | **Ads:** no API signal (`m2-twitch-vimeo-sync.md:80`). An ad does not fire ENDED **[inferred]**. **PAUSE at the end:** the docs don't say whether a PAUSE comes before ENDED. Ignore PAUSE for queue purposes. **Seek to end:** fires ENDED. | Report on ENDED when the embed is a VOD and not offline (the existing guard). |
| **Twitch live** | **No natural end.** `OFFLINE` ("Loaded channel goes offline") and `ONLINE` exist ([same page](https://dev.twitch.tv/docs/embed/video-and-clips/)). The ENDED wording "video or stream ends" could fire on stream end, but our adapter already suppresses it when offline. | Streams drop and reconnect, so offline is often temporary. Mid-roll ad slates pause and resume at the live edge (OME-500). | **Never auto-advance.** Offline keeps showing the existing notice (`m2-twitch-vimeo-sync.md:97`). Optional UX: after 10 minutes offline **[inferred threshold]**, show the owner or mods a "Skip to next" prompt. It is still a manual action. |
| **Vimeo** (Player SDK) | `ended` event, "triggered any time the video playback reaches the end". `getEnded()` is also available. [player.js README](https://github.com/vimeo/player.js) | **Loop:** with `loop` / `setLoop(true)`, `ended` does not fire (same README). We must not set loop. **Ads:** none. **Seek to end:** fires `ended`. | Report on `ended`. Assert `loop` is off in the adapter (a test exists or will be added in C2/X-side work). |
| **Generic tier** (ADR 0024) | **None.** Sandboxed, click-to-load iframe with no API and no sync (`docs/adr/0024-generic-embeds.md:58`). | n/a | **Manual next only** (owner or mod). |

### B3. Cross-cutting

- **Every client reports.** Each client's adapter fires ended at roughly the same time, so the server must dedupe on the queue item.
- **Seek to end is legitimate.** Whoever is allowed to `control` the room can already seek. Seeking to the end and getting ended is a valid skip, so the server rule must accept it. The position guard below uses the *room* clock, which a seek updates. A local-only seek on a client that is not allowed to control the room does not move the room clock, so the guard rejects it.
- **Late or behind clients** report after the item has advanced. Reject reports where `itemId` is not current. This is idempotent and needs no error toast.
- **Background tabs:** no primary source says whether provider ENDED events are delayed in throttled background tabs **[unverified]**. Treat client reports as best-effort and keep a server fallback timer when the duration is known.
- **Failed player / nobody watching:** if no client can report, the fallback timer (or manual next) covers it.
- **Duration:** the server does not know an item's duration today. Clients learn it from the player (`getDuration()` on all three providers). The guard and the fallback need it on the server.

---

## Contract implications (for C2, copy as-is)

1. **Queue item id.** Every queue item gets a server-assigned `itemId` (opaque string). The room's current item and its `itemId` are part of room state.
2. **New client message:** `{ type: "ended", itemId: string, rev: number }`.
   - Allowed only after `join`.
   - Valid only if `itemId` is the room's current item and the current embed is synced and **not live** (YouTube, Twitch VOD, Vimeo).
   - Generic and live embeds return a `not_endable` error or are silently ignored. Pick one; ignoring is simpler.
3. **Client rule** (web, not wire): send `ended` once per `itemId` when the adapter emits `state: "ended"` and all of these hold:
   - the client is not in an ad.
   - the provider's current video id equals the item's (the YouTube end-screen guard).
   - the embed is not live.
4. **Server rule:** the **first valid report wins** and the result is idempotent on `itemId`.
   - Any later report for that item, or for a non-current item, is ignored.
   - No quorum: one honest member is enough. A malicious member can only skip at the real end, because of rule 5.
5. **Early-report guard:** when the item's duration `D` is known, accept only if the server-estimated position is at least `D − 2 s`. The estimate is `position + (now − at) / 1000 × rate` while playing, or `position` if paused. Otherwise ignore the report.
   - `rev` in the report must be ≥ the room's last seek `rev`. An older `rev` means the report comes from before a seek, so it is stale.
6. **Duration:** add an optional `duration` (seconds, finite, > 0, capped) to the item.
   - The first client to load the player reports it through `status`, or a new optional field on `ended`/`status`. C2 decides which; the server takes the first plausible value.
   - Unknown duration means rule 5 is skipped, but first-report-wins and the current-item check still apply.
7. **Server fallback:** if the duration is known, the item is playing, and the room clock passes `D + 5 s` with no report, the server advances by itself.
8. **Manual next:** add `{ type: "queue-next", itemId }`, owner or mod only, for all embeds. It is the only way past live and generic items. It uses the same `itemId` idempotency.
9. **Advancing** bumps `rev` and broadcasts the new current item through the existing room pub/sub. No new socket or channel is needed.

## Sources

- Chrome: [program policies](https://developer.chrome.com/docs/webstore/program-policies/policies) · [MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements) · [user-data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) · [privacy policy](https://developer.chrome.com/docs/webstore/program-policies/privacy) · [dashboard privacy](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy) · [dashboard listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing) · [images](https://developer.chrome.com/docs/webstore/images) · [prepare](https://developer.chrome.com/docs/webstore/prepare) · [review process](https://developer.chrome.com/docs/webstore/review-process) · [troubleshooting / violation IDs](https://developer.chrome.com/docs/webstore/troubleshooting) · [manifest icons](https://developer.chrome.com/docs/extensions/reference/manifest/icons) · [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab) · [declare permissions](https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions)
- `https://developer.chrome.com/docs/extensions/reference/manifest/optional-host-permissions` returned 404 on 2026-10-09.
- Providers: [YouTube IFrame API](https://developers.google.com/youtube/iframe_api_reference) · [YouTube player parameters](https://developers.google.com/youtube/player_parameters) · [Twitch embed](https://dev.twitch.tv/docs/embed/video-and-clips/) · [Vimeo player.js](https://github.com/vimeo/player.js)
- The dashboard checkbox wording was only partly visible from the docs. Confirm it in the live dashboard during X1.
