# @omega/extension

WXT + TypeScript, Chromium MV3. The popup finds the video on the current page and shares it into a room.

```sh
bun run --filter @omega/extension build     # → .output/chrome-mv3 (shipped) + .output/chrome-mv3-e2e (Playwright)
bun run --filter @omega/extension dev       # WXT dev mode with reload
bun test apps/extension                     # unit tests
bun run ext:store                           # → .output/omega-share-<version>-chrome.zip for the Web Store (STORE.md)
```

Load unpacked: `chrome://extensions` → Developer mode → *Load unpacked* → `apps/extension/.output/chrome-mv3`.
Run e2e/perf against `.output/chrome-mv3-e2e` (`OMEGA_EXTENSION_DIR`). It has extra host permissions so Playwright can script a popup opened as a tab ([ADR 0005](../../docs/adr/0005-extension-permissions-and-e2e-build.md)).

## How it works
1. Opening the popup injects `collectCandidateUrls` (`src/scan.ts`) into the target tab: the page URL plus `iframe[src]`, `embed[src]` and `object[data]`. This is one-shot; there are no content scripts.
2. `listEmbeds` (`src/embeds.ts`) runs each URL through the contract's `canonicalizeEmbed` and dedupes by video. Anything off the allowlist is dropped.
3. **Share** → `shareEmbed` (`src/share.ts`) → `POST {server}/rooms/:id/share` with `{ url: <canonical embed url> }` and `Authorization: Bearer <shareToken>`. The request and response are parsed with `ShareRequestSchema` / `ShareResponseSchema`.
   - The token comes from `readShareTokens` (`src/share-token.ts`), a one-shot, read-only injection that reads `sessionStorage["omega.share"]` in open room tabs (ADR 0015).
   - Every server request also sends `ngrok-skip-browser-warning: 1`, `credentials: "include"` and `redirect: "manual"`.
4. **Add to queue** → `addToQueue` (`src/queue.ts`) → `POST {server}/rooms/:id/queue`, same body, token and errors as Share plus `queue_full`, response parsed with `QueueAddResponseSchema` (ADR 0031). Both buttons show `control_owner_only` (the room's owner-only control policy, ADR 0030) and `queue_full` in our own words.
5. The target tab is `?tabId=<n>` if present, else the active tab.

The room dropdown comes from `GET /rooms` (`loadRooms`, `src/rooms.ts`), which returns a probe outcome. `serverStatus` (`src/server-status.ts`) maps the probe, the host permission and the token onto the status line and the Share button: permission missing, tunnel unreachable, offline or HTML error page, edge sign-in, no room tab, or ready.

## Settings
Options page → server URL (default `https://omega-share.duckdns.org` in the production/store build, `http://localhost:8787` in dev and e2e builds), stored in `chrome.storage.local` under `serverBaseUrl`. It must be a bare origin: `https://` with a host name (IP literals only for loopback), or `http://` only for `localhost`, `127.0.0.1` and `[::1]`. A non-default origin asks for that host permission at save time.

## Permissions
`activeTab`, `scripting` (inject the scan on popup open), `storage` (server URL), and the default server's origin as the one host permission, so `fetch` needs no CORS. Other origins are optional (`https://*/*` plus loopback over http) and granted at runtime. `test/manifest.test.ts` checks the built manifests, and `bun run ext:store` refuses to zip anything else (`store/manifest.ts`).

## Test ids
| Popup | |
|---|---|
| `embed-list` | list of found embeds |
| `embed-item` | one per embed (`data-video-id`), contains a radio input |
| `embeds-loading` | shown while scanning |
| `embeds-empty` | "No supported video found on this page." |
| `embeds-unreadable` | "Can't read this tab." (chrome:// pages, the web store, a failed scan) |
| `room-select` | room dropdown |
| `share-button` | share the selected embed |
| `queue-button` | add the selected embed to the room's queue |
| `share-status` | result; `data-state="ok" \| "error"` |
| `server-status` | server/tunnel state line (§5.4); hidden when ready |
| `open-options` | opens the options page |

| Options | |
|---|---|
| `server-url-input` | server URL |
| `server-url-save` | save |
| `server-url-status` | result; `data-state="ok" \| "error"` |
