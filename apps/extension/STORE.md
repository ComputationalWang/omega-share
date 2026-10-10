# Store listings: omega share (Chrome Web Store and Firefox Add-ons)

Everything the submissions need, ready to paste into the developer dashboards. The Firefox (AMO) listing is [below](#firefox-addonsmozillaorg-listing). Policy background and sources: [`docs/research/m6-store-and-ended.md`](../../docs/research/m6-store-and-ended.md) (R1, OME-501). The developer account and the submission are a board step.

## Package

```sh
bun run ext:store
# → apps/extension/.output/omega-share-<version>-chrome.zip   (Chrome Web Store)
# → apps/extension/.output/omega-share-<version>-firefox.zip  (AMO)
# → apps/extension/.output/omega-share-<version>-sources.zip  (AMO source upload; prints size and sha256 of each zip)
```

- **Production build only.** The script builds `mode: production` and runs the packaging guard (`store/manifest.ts`) on the built `manifest.json` before zipping. The guard fails the build on the e2e build's host permissions, `<all_urls>`, an http wildcard, extra permissions, content scripts, a persistent background, missing icons, or a version that isn't `package.json`'s. Never zip `.output/chrome-mv3-e2e`.
- **Version** comes from `apps/extension/package.json`. Bump it there before each upload; the store rejects a version it has already seen.
- **Reproducible.** Entries are sorted and carry a fixed date and no Unix metadata, so the same source gives the same sha256 (checked in `test/store.test.ts`). The cap is 500 KB; today's zip is about 19 KB.
- **Default server** in this build is `https://omega-share.duckdns.org` (dev and e2e builds keep `http://localhost:8787`).

## Listing

**Name:** omega share

**Summary (≤ 132 characters, from the manifest):** Share the video on this page into an omega-share room.

**Category:** Social & Communication

**Language:** English

**Description:**

> Watch videos together in a cozy pixel-art room.
>
> Open the extension on a page with a YouTube, Twitch or Vimeo video, pick your omega-share room, and click Share. The video starts for everyone in the room, in sync. Click Add to queue instead to line it up after the current one.
>
> - Finds the video on the page you are on, including embedded players.
> - Shares into any room you have open in a tab.
> - Other embedded clips can be shared too; they aren't synced, and each person starts them with a click.
> - Works with the hosted server out of the box, or point it at your own omega-share server in the options.
>
> The extension only looks at a page when you open it, sends nothing until you click Share or Add to queue, and has no analytics. omega-share is free software (AGPL-3.0).

**Single purpose:** Finds a video embed on the page you are viewing and shares it into an omega-share watch room, where everyone in the room watches it in sync.

**Homepage URL:** https://omega-share.duckdns.org/

**Privacy policy URL:** https://omega-share.duckdns.org/privacy.html#extension (the W3 privacy page; its Extension section is `apps/web/privacy.html#extension`)

## Images (`assets/store/`)

| Slot | File | Size |
|---|---|---|
| Store icon | `assets/store/icon-128.png` | 128×128 (artwork 96×96, 16 px transparent padding, as Google suggests) |
| Small promo tile | `assets/store/promo-440x280.png` | 440×280 |
| Screenshot 1 | `assets/store/screenshot-1-room.png` | 1280×800 |
| Screenshot 2 | `assets/store/screenshot-2-share.png` | 1280×800 (the real popup, shot by `assets/src/shoot-popup.ts`) |
| Screenshot 3 | `assets/store/screenshot-3-chat.png` | 1280×800 (chat bubbles, emotes and the emote wheel in the room) |
| Screenshot 4 | `assets/store/screenshot-4-queue.png` | 1280×800 (the shared "Up next" queue) |
| Marquee | `assets/store/marquee-1400x560.png` | 1400×560 |

Every file is under 1 MB; `assets/src/store-kit.test.ts` checks sizes and dimensions.

The manifest icons (16, 32, 48, 128) are copied from the same files at build time.

## Privacy practices tab

**Permission justifications:**

| Permission | Justification |
|---|---|
| `activeTab` | When you open the popup on a page, this lets the extension read that one tab to find its video embeds. No other tab is touched. Access ends when you leave the page. |
| `scripting` | Used with activeTab to run one read-only function bundled in the extension. It lists the page's video embed URLs. It is also used to read the room share token from your open room tabs on your chosen server. No remote code. |
| `storage` | Saves the server address you enter on the options page. |
| Host permission `https://omega-share.duckdns.org/*` | Lets the popup call the omega-share server's share, add-to-queue and room-list endpoints. This is the only site the extension contacts by default. |
| Optional host permissions `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*`, `http://[::1]/*` | You can point the extension at a self-hosted omega-share server on any https domain, or on this computer. The extension asks for that one origin at runtime, only after you save it in the options page. Nothing is granted at install. The old origin is removed when you change servers. |

**Remote code:** No, I am not using remote code.

**Data usage (tick these):**
- Website content (embed URLs found on the page)
- Web browsing activity (the shared video URL leaves the device when you click Share or Add to queue)
- Authentication information (the room share token is sent as a bearer token)

Do not tick personally identifiable information, health, financial and payment, personal communications, location, or user activity.

**Certifications:** tick all three (not sold to third parties; not used for purposes unrelated to the single purpose; not used for creditworthiness or lending).

## Notes for the reviewer (Test instructions field)

> No account or login is needed.
>
> 1. Open https://omega-share.duckdns.org/ in a tab, pick a nickname, and join any public room (or create one). Keep that tab open: the extension shares into rooms you have open.
> 2. In another tab, open a YouTube video page, for example https://www.youtube.com/watch?v=aqz-KE-bpKQ.
> 3. Click the omega share toolbar icon. The popup lists the video. Pick the room and click Share: the video plays in the room tab. Or click Add to queue to add it after the current video.
>
> The extension reads a page only when its popup is opened (activeTab). It has no content scripts and no background activity.

---

# Firefox (addons.mozilla.org) listing

OME-593; research and the CEO's decisions are in R-M7c ([OME-546](/OME/issues/OME-546#document-findings)). The board does the Mozilla account and the submission. The add-on is **listed** for Firefox (desktop) and Firefox for Android ([OME-743](/OME/issues/OME-743)), and free.

## Package

- **Upload:** `omega-share-<version>-firefox.zip` from `bun run ext:store`. It is the same production code as Chrome. The manifest adds the gecko keys and uses an event-page background, because Firefox MV3 has no service worker. Never upload `.output/firefox-mv3-e2e`.
- **Checks before zipping:** the Firefox packaging guard (`checkStoreManifest(…, "firefox")`) and `web-ext lint`, which is AMO's own validator. Lint must give 0 errors and 0 warnings. Any finding stops the build (ADR 0005).
- **Add-on ID:** `omega-share@omega-share.duckdns.org`. **It is permanent.** Never change it, or the listing and every install are lost.
- **Minimum version:** Firefox 140 (desktop) and Firefox for Android 142 (`gecko_android`; 142 is the first Android release that reads `data_collection_permissions`). In the "compatible with" step tick both **Firefox** and **Firefox for Android**.
- **On Android** the toolbar button lives in the browser menu: ⋮ → Extensions → omega share opens the popup as a full-screen sheet. Opening it from there grants `activeTab`, as the toolbar button does on desktop.
- **Source code:** the build is bundled and minified, though not obfuscated, so answer **Yes** to "Do you need to submit source code?". Upload `omega-share-<version>-sources.zip`. It contains `SOURCE-BUILD.md`, whose steps are Bun 1.4.2, `bun install --frozen-lockfile` and `bun run ext:store`, and they rebuild a byte-identical zip (checked by `test/sources.test.ts`). Build both zips from a clean checkout of the release commit; `ext:store` warns if the tree is dirty.

## AMO API (`bun run ext:amo`, ADR 0038)

Since 0.1.0, versions go up through the AMO API with the board's key ([OME-757](/OME/issues/OME-757)). Set `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` in the environment, from the Paperclip secrets `FIREFOX_JWT_ISSUER` / `FIREFOX_JWT_SECRET`, never on the command line:

```sh
sec() { curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" "${PAPERCLIP_API_URL%/}/api/agents/me/secrets/$1/value" | jq -r .value; }
AMO_JWT_ISSUER="$(sec omega-share-firefox-firefox_jwt_issuer)" AMO_JWT_SECRET="$(sec omega-share-firefox-firefox_jwt_secret)" bun run ext:amo status
```

- **`status`** (read-only, anyone, any time): the listing status, then each version's channel, review status and file status.
- **`submit`**: only on a CEO-filed release issue, after QA signed off on the SHA, with a version bump. Run `bun run ext:store` in a clean checkout of that SHA first. `submit` rebuilds both zips and refuses if a hash differs, if the tree is dirty, or if the version isn't newer than every version on AMO. It then uploads the Firefox zip as a new **listed** version for Firefox and Firefox for Android, attaches the sources zip, and prints the version URL and both sha256s. Post that output on the release issue.
- Listing text and metadata aren't touched by the tool. They stay a board or CEO call.

## Listing

**Name:** omega share

**Add-on URL slug:** omega-share

**Summary (≤ 250 characters):** Share the video on this page into an omega-share room, where everyone watches it together in sync.

**Description:** use the same text as the Chrome listing above.

**Categories:** Social & Communication

**Tags:** video, watch party, youtube, twitch, vimeo

**Support email / site:** the source repository's issue tracker (the link in the site footer)

**Homepage:** https://omega-share.duckdns.org/

**License:** GNU Affero General Public License v3.0 only. If AGPL isn't in the list, pick "Custom license" and paste `LICENSE`.

**Privacy policy:** https://omega-share.duckdns.org/privacy.html#extension (its Extension section names the three data categories below)

**Images:** the icon is `assets/store/icon-128.png` (AMO also takes 64×64; the 128 px file scales). Screenshots are the four 1280×800 files from the Images table above (AMO has no marquee slot).

## Data collection (what Firefox shows at install)

The manifest declares `data_collection_permissions.required: ["websiteContent", "browsingActivity", "authenticationInfo"]`. The listing and any reviewer question must match:

| Category | Why |
|---|---|
| Website content | When you click Share or Add to queue, the address of a video embedded in the page you are on goes to the omega-share server you chose. |
| Browsing activity | When the video is the page itself (for example, a YouTube watch page), that address is a page you visited. |
| Authentication information | The room share token, read from your open room tab and sent as a bearer token, only to the omega-share server you chose and only when you click Share or Add to queue. It proves you are in the room; it is not a password or account login. |

Nothing is optional, so there is no opt-in screen. Mozilla's policy 6.2.2.2 treats a send that is the direct result of a single deliberate user action (the Share click) as consented. There are no analytics and no other transmission.

## Notes for the reviewer

> No account or login is needed.
>
> 1. Open https://omega-share.duckdns.org/ in a tab, pick a nickname, and join any public room (or create one). Keep that tab open: the extension shares into rooms you have open.
> 2. In another tab, open a YouTube video page, for example https://www.youtube.com/watch?v=aqz-KE-bpKQ.
> 3. Click the omega share toolbar button. The popup lists the video. Pick the room and click Share: the video plays in the room tab. Or click Add to queue to add it after the current video.
>
> The extension reads a page only when its popup is opened (activeTab + scripting.executeScript of one bundled, read-only function). It has no content scripts, its event page has no listeners, and it loads no remote code. On Share it also reads the room share token from the open room tab (on the server you chose) and sends it to that server as a bearer token, which is why the manifest declares authentication information. The code is bundled and minified with WXT/Vite, not obfuscated. SOURCE-BUILD.md in the source upload rebuilds the identical zip.

## Manual check before submitting (QA, headed, on a virtual display)

These two things can't be automated. Run them in Firefox ≥ 140 under `xvfb-run` (board rule; see `docs/qa/headed-on-xvfb.md`):
1. Load `.output/firefox-mv3` from about:debugging. Click the real toolbar button on a YouTube watch page and check that the video is listed. This tests the `activeTab` grant.
2. Open the options page (it opens in a tab), save an https server, and accept the permission prompt. Check that the popup then uses that server.
