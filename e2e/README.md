# e2e + perf harness

Playwright + Chromium. Config: `playwright.config.ts` (projects `e2e` and `perf`).

```sh
bunx playwright install chromium   # once
bun run e2e                        # smoke/e2e specs (e2e/**/*.e2e.ts)
bun run perf                       # builds apps, runs perf checks, prints the budget report
bun run perf --no-build            # reuse existing builds
bun run perf --strict              # pending budgets also fail
bun run perf --soak                # also the 10 min JS heap soak (post-merge full suite); OMEGA_SOAK_MS shortens it, but a short soak stays PENDING
```

Specs are named `*.e2e.ts` / `*.perf.ts` (not `*.spec.ts`) so `bun test` doesn't pick them up.

## What starts automatically
Playwright's `webServer` starts the fixture server (`e2e/fixtures/server.ts`, port 4400). It adds `apps/server` and `apps/web` once they have a `dev` script. Perf serves the web app with `preview` (production build) when that script exists. Ports and URLs: `OMEGA_FIXTURE_PORT`, `OMEGA_WEB_PORT` / `OMEGA_WEB_URL`, `OMEGA_SERVER_PORT` / `OMEGA_SERVER_URL`.

Specs for pieces that haven't landed yet are `test.fixme` (e2e) or reported as PENDING (perf). See `e2e/support/apps.ts`. `bun run e2e` builds the e2e extension (`build:e2e`) before running Playwright. If you call `playwright test` directly without that build, the extension specs fail with the build command. They are never skipped.

## Helpers (`e2e/support/`)
- `extension.ts`: `test` with a persistent Chromium context that loads the unpacked **e2e build** from `apps/extension/.output/chrome-mv3-e2e` (override with `OMEGA_EXTENSION_DIR`). That build is the shipped code plus host permissions for `http://localhost/*` and `https://www.youtube.com/*`, because Playwright can't grant `activeTab` ([ADR 0005](../docs/adr/0005-extension-permissions-and-e2e-build.md)). `bun run perf` runs the static manifest checks (content scripts, persistent background) against the **shipped** build in `apps/extension/.output/chrome-mv3` (`EXTENSION_SHIPPED_DIR`). The extension's `build` script writes both. Fixtures: `extensionId`, `serviceWorker`, `openPopup(page)`.
- `network.ts`: every non-localhost request is stubbed, so runs are offline. `https://www.youtube.com/watch?v=…` serves `watch-url.html`. Use `gotoFixture(page, name)`.
- `room.ts`: `joinRoom(browser, { roomUrl, count })` creates N contexts. Each gets its own nickname and avatar and joins the room.
- `selectors.ts`: the `data-testid` contract with the apps. Change it here, not in specs.

## Fixture pages (`e2e/fixtures/pages/`)
`youtube-embed` (one allowlisted embed), `watch-url` (the tab URL is the video), `non-allowlisted` (unknown provider, lookalike host, path spoof, `javascript:`/`data:`; must list nothing), `no-video`.

## Contract for app engineers
- **Popup** (OME-7): `popup.html?tabId=<n>` must target tab `n`. A popup opened as a tab can't use the active tab. Render `data-testid="embed-item"` per embed and `embeds-empty` when there are none. Popup-to-list time runs from the popup's navigation start until the first `embed-item`.
- **Site** (OME-6): test ids from `selectors.ts`, rooms at `/r/<room>`, `bun run --filter @omega/web dev|preview -- --port <p> --strictPort`, `build` → `apps/web/dist`. Optionally call `performance.mark("omega:interactive")` when the room is usable; TTI takes the latest of that mark, DOMContentLoaded and the last long task.
- **Server** (OME-5): `dev` script reads `PORT`.

## Perf report
`bun run perf` writes `perf/results/report.md` and `report.json` (git-ignored) and exits 1 if any budget fails. Budgets live in `perf/budgets.ts`. A unit test checks them against `docs/perf-budgets.md`, so edit both together. Every row in the doc needs a budget (unmeasured ones report PENDING). The load test (`perf/load.perf.ts`) fills the room to 25 with `startTraffic` bots from `support/bots.ts`, which chat, sit/stand and sample relay latency.
