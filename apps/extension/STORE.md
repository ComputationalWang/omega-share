# Chrome Web Store listing: omega share

Everything the submission needs, ready to paste into the developer dashboard. Policy background and sources: [`docs/research/m6-store-and-ended.md`](../../docs/research/m6-store-and-ended.md) (R1, OME-501). The developer account and the submission are a board step.

## Package

```sh
bun run ext:store
# → apps/extension/.output/omega-share-<version>-chrome.zip (prints its size and sha256)
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
| Marquee | none | optional, skipped |

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
