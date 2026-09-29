# ADR 0005 — Extension permissions and the e2e build variant

**Status:** accepted (2026-09-29) · [OME-7](/OME/issues/OME-7) · details in `apps/extension/README.md`

**Decisions:**
- The shipped extension asks for `activeTab`, `scripting`, `storage` and one host permission: the default server origin (`http://localhost:8787/*`), so the popup can `fetch` the share endpoint without CORS. There are no content scripts. The service worker has no listeners.
- A different server URL (ngrok, hosted) is requested at runtime from the options page (`optional_host_permissions: http://*/*, https://*/*`, granted per origin). The previously granted non-default origin is removed.
- The page scan is injected only when the popup opens (`scripting.executeScript` on the top frame). It returns raw URLs, and the popup keeps only what `canonicalizeEmbed` accepts.
- `bun run build` writes **two** unpacked dirs:
  - `.output/chrome-mv3`: the shipped build. Load it by hand and run the manifest checks against it.
  - `.output/chrome-mv3-e2e`: `wxt build --mode e2e`. It is identical except for extra host permissions `http://localhost/*` and `https://www.youtube.com/*`.

**Why:** Playwright can't click the toolbar button, so it can't grant `activeTab`. It opens `popup.html?tabId=<n>` as a tab and resolves `n` with `chrome.tabs.query`, and both need host permission for the target page. Adding those permissions to the shipped build would widen what we ask real users for. The e2e variant keeps them out of the shipped build while exercising the same code.

**Revisit if:** Chromium or Playwright gains a way to invoke the action (and so grant `activeTab`) in tests. Then drop the variant and run e2e against the shipped build.
