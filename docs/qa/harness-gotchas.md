# Harness gotchas

Test-harness oddities that cost real review time. Check here before debugging a harness oddity. Entries name the issue where each was found.

## Ports, servers and concurrent runs

**Check who owns a port before you kill or trust it** (OME-9, OME-97, OME-160, OME-444, OME-797). Playwright's `reuseExistingServer` (non-CI) silently tests whatever listens on 4400/5173/8787 (QA2: 4410/5183/8797). Before every e2e or perf run, `ss -ltnp`, then `readlink /proc/<pid>/cwd`: it must point into your worktree. A `(deleted)` cwd with no playwright or perf process running is an orphan (stale `vite preview` and server from a removed worktree, or a perf run's leftovers): kill it by PID, or every e2e test times out with "Connection lost, reconnecting...". Distrust reds that overlapped another agent's run (duplicate nickname tags, "Room full", `websocket error`). A green run that reused a foreign server does not count.

**Kill by PID, never by pattern.** `pkill -f` and `pgrep -f ... | kill` match your own shell's command line and kill it (exit 144). Use `ps -eo pid,args | grep "[p]attern"` and kill in a separate command, or match by `/proc/<pid>/cwd`.

**QA lanes** (OME-125, OME-163, OME-366). QA Engineer uses the defaults, QA2 uses 4410/5183/8797 (fallback 4450/5223/8857). Never use 5193/8807 (`persistence.e2e.ts`), 8817 or 8837/8847 (generic-policy). If those collide: `CI=1 OMEGA_PERSIST_SERVER_PORT=8857 OMEGA_PERSIST_WEB_PORT=5203 OMEGA_GENERIC_ON_PORT=8837 OMEGA_GENERIC_OFF_PORT=8847 bun run e2e`. Fully free alternate set that passed (OME-663): `OMEGA_FIXTURE_PORT=4610 OMEGA_WEB_PORT=5333 OMEGA_SERVER_PORT=9107 OMEGA_PERSIST_SERVER_PORT=9117 OMEGA_PERSIST_WEB_PORT=5343 OMEGA_GENERIC_ON_PORT=9127 OMEGA_GENERIC_OFF_PORT=9137`. Derived ports to check too: proxy fixtures+30..+34, server +1/+2/+4/+6/+100. `OMEGA_*_PORT` offsets don't work for extension specs (the extension hardcodes `localhost:8787` in `apps/extension/src/settings.ts`).

**Per-spec server offsets** (OME-602). Specs that start their own server use `PORTS.server + N`. Run `grep -rnoE 'PORTS\.(server|proxy) *\+ *[0-9]+' e2e` before picking N (+1/+2/+4 tunnel, +6 moderation-queue-abuse, +8 m7-report-abuse, +100 tunnel-proxy). A duplicate passes alone and goes red only in the full parallel run as EADDRINUSE.

**Concurrent QA and QA2 full runs** (OME-714). The two lanes' fixed offsets overlap, and CPU sharing flakes popout and sync specs. Before calling it red, check playwright cwds, then rerun the failed files with `--workers=1`. EADDRINUSE on a fixed-port spec is an environment collision, not a regression.

**Prove "no traffic to port X"** (OME-115): `DEBUG=pw:protocol bun run e2e 2>&1 | grep -E 'Network.(requestWillBeSent|webSocketCreated)'`. This covers the extension's persistent context, which `--trace` doesn't. `ss` polling misses refused connects.

## Worktrees and the gate

**False gate failures in the shared root** (OME-581). The root checkout holds untracked `omega-share-worktrees/` and `.claude/worktrees/`: `eslint .` runs out of heap, `bun test` collects about 24k tests and server process tests fail. Gate in a clean worktree: `git worktree add --detach $PAPERCLIP_RUN_SCRATCH_DIR/x main && bun install --frozen-lockfile && bun run check`.

**Scratch files in a worktree break lint** (OME-360). eslint reads every `.ts` file, tracked or not ("not found by the project service"). Keep scratch in `omega-share-worktrees/qa2-scratch-<name>/` or the run scratch dir, and run `git status --short` before `check`. An untracked spec in `perf/` is picked up by `bun run perf`.

**Review in a detached scratch worktree** (OME-521, OME-556). `git worktree add --detach <absolute path> <sha>` then `bun install`. Always an absolute path: a relative one nests the worktree in the repo and the tests run against main. Never `git stash` (the stash list is shared by every worktree). Running `bunx playwright test` directly skips the extension build: run `bun run --filter @omega/extension build:e2e` first.

**Shell hygiene** (OME-470, OME-511). `cd X; git ...` runs git in the old directory when the `cd` fails (once detached the shared `main`): use `cd X && git ...`. `cd X && setsid nohup ... & disown; git add` backgrounds the whole `&&` chain, so later commands run in the old cwd: put the detached job in its own Bash call. The QA2 worktree is `/home/wang/Projects/omega-share-worktrees/qa2`.

**Milestone reports go in `docs/qa/`** (OME-511), not in git-ignored `perf/results/`. Let the script write there and commit a copy.

## Playwright and Chromium

**`test-results/` is wiped at the start of every run** (OME-606). A second `bunx playwright test` in the same worktree during a full run turns passing tests flaky (ENOENT on traces). Side runs: `--output=<dir outside the worktree> --trace off`. Keep evidence elsewhere (`e2e/real/results/`).

**Playwright grants user activation** (OME-91). `navigator.userActivation.hasBeenActive` is true about 20 ms after load, even with `--autoplay-policy=document-user-activation-required`, so autoplay-blocked paths are unreachable. Spawn `chromium.executablePath()` with `--remote-debugging-port` and drive it over raw CDP (`rawTab` in `e2e/real/real.ts`); the tab needs `Page.bringToFront` and `Emulation.setFocusEmulationEnabled`, or rAF stays at 0.

**No setup reports a tab hidden** (OME-598). Headless, minimised, foreground target, `window.open`, headed under xvfb: `visibilityState` stays `visible`. Use the init script `hideable()` in `e2e/popout.e2e.ts` and say in the issue that hidden is emulated.

**Self-closing windows** (OME-635). Open pop-outs with `page.evaluate(() => window.open(url, "_blank", "noopener,popup"))`: windows from `context.newPage()` ignore `window.close()`. Find them by polling `context.pages()` (`waitForEvent("page")` can hang on connectOverCDP). Raw Chromium under xvfb needs `--window-size=1280,900` and `xvfb-run -s "-screen 0 1600x1000x24"`, or the page drops to the phone layout.

**CDP Escape never exits browser full screen** (OME-597). Simulate with `document.exitFullscreen()`; for the real key, run headed under the xvfb wrapper and `xdotool key Escape`. Pace toggles about 500 ms apart: `requestFullscreen()` right after an exit can be refused.

**A cancel-prevented `<dialog>` survives two real Esc presses** (OME-640). Test "closed mid-request" with `dialog.close()` in `page.evaluate` and report it as hardening. Touch-size probes need a `hasTouch`/`isMobile` context; `.ui-touch .ui-button::before` grows taps to 44 px, so a smaller `getBoundingClientRect` is not a miss.

**`ariaSnapshot()` ignores `inert`** (OME-630). It still lists inert content. Use CDP `Accessibility.getFullAXTree` via `context.newCDPSession(page)` (`inertElement`/`inertSubtree`). The TV's empty state contains "Up next", so a text match gives a false positive.

**Touch drags fire no click, mouse drags always do** (OME-614). Test drag-versus-tap code with CDP `Input.dispatchTouchEvent` (start, a few moves about 8 px apart, end) in a touch context, then press Enter on a control in the dragged area: it must act on the first press.

**Headed xvfb differs from headless** (OME-646). No window manager: `document.hasFocus()` is always true, so window raise is unobservable (judge from code and unit tests, and say so). Classic 15 px scrollbars expose overflow headless misses (a 3 px pop-out overflow clipped keys). Take a headed screenshot for any new window or layout and log `scrollWidth` against `clientWidth`. Headed runs use the xvfb wrapper `e2e/support/headed.ts`; a plain `xvfb-run` trips `requireVirtualDisplay`.

**Stubbed responses can have an empty `body()`** (OME-763). A `route.fulfill` image reported an empty body with `content-length: 204800`. Byte-counting harnesses fall back to the declared length (`responseBytes()` in `perf/landing.ts`). Always prove a budget spec red with a stub.

**Fake SDK fixtures serialize via `toString()`** (OME-599). `installFakeTwitch` is shipped as `(${installFakeTwitch.toString()})(window)`, so every constant it uses must live inside the function. A module-level const throws in the page, the player still plays, and the feature silently does nothing. Unit tests import the module and miss it.

**Frame-timing specs need `trace: "off"`** (OME-733). The `retain-on-failure` screencast drops vsyncs (ADR 0017), so walk-tier probes stay Basic in the 8-worker run. Use `test.use({ trace: "off" })` and a retry over up to three room starts.

**Mock-up shots of time-based CSS** (OME-644). `animations: "disabled"` fast-forwards fades to invisible. Freeze each element with a negative `animation-delay` plus `animation-play-state: paused` and shoot with `animations: "allow"`. `file://` pages can't `fetch()` local JSON in Chromium.

**Ad-hoc spec reusing the repo config** (OME-394). In a `qa2-scratch-*` dir: symlink `node_modules` to `../qa2/node_modules`; `package.json` with `{"type":"module"}` (else "Cannot use 'import.meta' outside a module"); a `playwright.config.ts` spreading `../qa2/playwright.config` with `webServer` `cwd` set to the qa2 path and one `e2e-real` project with `testDir: "."`. Run `bun ../qa2/e2e/support/headed.ts ../qa2/node_modules/.bin/playwright test -c playwright.config.ts` with the QA2 ports exported, detached. For an A/B, `git checkout --detach <old>` in qa2, rerun, then back to `main`.

## Seeded rooms and server limits in e2e

**Room creation is rate limited** (OME-417, OME-507). `POST /rooms` allows 2 per 10 min per key (browser is always 127.0.0.1), then a global 10 and 1 per minute, with no env override. New specs needing an owner token or invite key add a room to `e2e/support/owned-rooms.ts` (seeded by `fixtures/seed-rooms.ts`) and seed `localStorage["omega.rooms"]`. Names must be 9 letters or fewer: the token `QaOwnerToken-<name>` is `padEnd`ed to 22 chars and a longer name gives an invalid token (`invite_required`). Perf specs can use owned rooms too; `shareVideo` joins without a key, so post the share with the owner token from `sessionStorage["omega.share"]`.

**Repeats share the seeded room** (OME-418). `--repeat-each=N --workers=3` runs a test's copies concurrently in one room and collides. Check stability with `--workers=1`. A spec that spends an owned room picks it by `repeatEachIndex * 2 + retry` (CI sets `retries: 1`; see `e2e/extension-queue.e2e.ts`).

**Loopback sockets are unkeyed** (OME-510). Kick cooldown, mute memory and per-address caps never apply to loopback (`isLoopbackKey`). Not an app bug. Follow `e2e/moderation-queue-abuse.e2e.ts`: a per-test server with `TRUST_PROXY=loopback` on `OMEGA_SERVER_PORT + 6` and an `X-Forwarded-For` per socket.

**Server headers don't reach Vite e2e** (OME-273). CSP header, Trusted Types and HSTS from `apps/server/src/headers.ts` only reach pages in `e2e-tunnel` and the real-tunnel run; regular e2e and `e2e:real` go through Vite dev with only the `<meta>` CSP. Prove header changes against the server-served build: build with `NODE_ENV=development VITE_SERVER_URL=http://localhost:8817 bunx vite build --mode development --outDir <scratch>` (without `NODE_ENV` there is no `window.__omega`), start `PORT=8817 SITE_ORIGIN=http://localhost:8817 STATIC_DIR=<scratch> bun apps/server/src/index.ts`, then `bun run e2e:real <spec>` with `OMEGA_WEB_URL=OMEGA_SERVER_URL=http://localhost:8817`, in the foreground. Real YouTube needs a `youtube-widget-api` Trusted Types policy.

## Perf

**Run perf under the machine-wide lock** (OME-185). `flock "$XDG_RUNTIME_DIR/omega-share-perf.lock" bun run perf`. For the frame row: `OMEGA_WEB_MODE=preview flock ... bunx playwright test --project=perf --trace off perf/site.perf.ts perf/provider-sync.perf.ts -g frame` (expect 0 % missed). `bun run perf` takes spec paths (`perf/chat.perf.ts`), not bare names, and baselines older than 4f09dac run the whole suite.

**Detach long runs** (OME-334). Background jobs die at run teardown and Bash caps at 10 min. Use `setsid nohup bash -c '<cmd>; echo "EXIT=$?"' > log 2>&1 < /dev/null & disown`, then poll `grep -q ^EXIT= log` in loops under 10 min, with the `flock` inside the `bash -c`. Don't wrap `flock` in `timeout` (OME-652): it expires while waiting and orphans your preview, server and fixture processes.

**Don't build or edit in the perf worktree mid-run** (OME-301). Perf serves `apps/web/dist` via preview; a build swaps chunks and times out frame specs. Bisect bundle sizes in a second worktree.

**Single perf spec by hand** (OME-294, OME-523, OME-525). The preview build needs `VITE_SERVER_URL=http://localhost:$OMEGA_SERVER_PORT` baked in (else "Connection lost"), and `mkdir -p perf/results` in a fresh worktree (git-ignored, only `perf/run.ts` creates it). Soak alone, once dist exists: `OMEGA_PERF_SOAK=1 OMEGA_WEB_MODE=preview flock ... bunx playwright test --project=perf --trace off perf/soak.perf.ts` (about 10 min, writes `site.heapAfterSoak.json`). Don't count lock wait as a hang.

**`bun run perf` exits 0 even when a budget test failed** and passed only on retry (OME-733). Grep the log for `✘` and `Received`. `report.md` keeps the retry's numbers and omits the editor, moderation and polish rows: read `perf/results/{editor,moderation,polish}.json` and compare mtimes (OME-527).

**Metric files persist** (OME-452, OME-736). Per-metric JSONs live in `perf/results/metrics/*.json`. `rm -f` the one you sample before each run (a `-g` matching nothing leaves the old file: six identical "214 ms"), copy the subdir after each run when looping, and check titles with `--list`. Sync-spread rows are bimodal: sample 8 or more runs before calling a budget.

**Load noise vs regression** (OME-408, OME-567, OME-652, OME-656, OME-693, OME-731, OME-749). Missed vsyncs of 1-4 in 300 frames and whole-spec reds follow load average, not code (also another agent's Android emulator at 350 % CPU). Print `uptime` with each run; every results row records `load1` and `at`. On a lone fail rerun the spec flocked 3 times with `--retries=0` before blocking a merge. The deciding evidence is an interleaved A/B against main (or the pre-merge base) in a second worktree built with the same `VITE_SERVER_URL`, copying the same spec into both. Real regressions reproduce and show in work p95. Known noisy rows: `fullscreen.perf` (most load-sensitive) and `chat.missedVsync.generic` at about 1.0 % against a 1 % budget (OME-813). A lone chat-generic red is noise until that row is stabilised. For 8-iteration A/B loops in the background pass a timeout of at least 1500000.

**Perf has no dev handle** (OME-418). `window.__omega` exists only in the Vite dev build that e2e uses. In perf, prove activity from outside: `page.on("websocket")` `framereceived` plus `parseServerMessage`, or DOM tag transforms before and after the window. Leave "is it drawn" to e2e.

**Pace drags** (OME-596). Back-to-back `page.mouse.move` forces a style recalc per event. `waitForTimeout(16)` between moves, and in app code write drag transforms from one rAF and flush on pointerup. Before sit clicks in a perf spec, scroll first and wait: a forced click right after a scripted scroll lands on the TV iframe (OME-89).

**Blink restyles every element with a running CSS animation or transition each main frame**, even composited ones (OME-802). Any rAF loop (Pixi, the perf frame counter) makes that one recalc per frame. A step on rule-heavy elements costs about 1 ms against 0.1 ms on a bare wrapper div. In the room page avoid long-running decorative CSS animations: step motion from a shared timer writing `translate`/`opacity`/`transform` to a bare wrapper, and don't read layout per message (use a ResizeObserver). Profile with `devtools.timeline` added to the trace in a local `perf/frames.ts` patch; `invalidationTracking` and `timeline.stack` inflate FunctionCall durations, so decide on untraced interleaved A/B runs.

**Real-site probes** (OME-661, OME-673, OME-246). Twitch gear: hover the iframe centre, click `player-settings-button`, then `player-settings-menu-item-quality`, then `player-settings-submenu-quality-option` (`data-a-target`; a second click on the button closes it). Prove the room is untouched with WS `control` frames sent by the actor and `playback` frames received by another member; sampling `<video>` can't tell an ad from the broadcast. Vimeo `1084537` is a free account (lists qualities, refuses `setQuality`, no key shown); `76979871` is paid and shows the key. Twitch's mature gate hits most top live channels logged out: detect it by the `content-classification-gate-overlay-start-watching-button` target (the `<video>` keeps advancing), and use `liveInCategories`/`gateShown` in `e2e/real/providers.ts`. Headed real runs during perf cause frame fails.

## Firefox and Android rigs

**Playwright can't load Firefox extensions** (OME-546, OME-593). The lane is `bun run ext:firefox` with `e2e/support/firefox.ts` (Puppeteer WebDriver BiDi). Facts:
- Launch with `args: ["-remote-allow-system-access"]` and `browser.installExtension(dir)` (manifest needs `browser_specific_settings.gecko.id`). BiDi refuses `page.goto("moz-extension://...")` and input actions on extension pages ("privileged scope"): click with `$eval(sel, b => b.click())`, and open the popup via an e2e-only background `tabs.onUpdated` listener that opens `popup.html?tabId=N`.
- Match patterns with a port never match in Firefox (OME-687): `tabs.query`, `executeScript`, `permissions.contains` and `permissions.request` all fail. Port-less patterns (`https://host/*`, `http://localhost/*`) match every port. Run Firefox Share repros on 8787. Server must accept `moz-extension://<uuid>` origins (the UUID is random per install).
- `executeScript` without `injectImmediately: true` waits about 1 s when the target tab is in the background (popup p95 1378 to 87 ms). Firefox drops about 1 in 80 `tabs.onUpdated` fragment events, so the harness re-sets the hash after 2 s. Stubbed external iframes never fire load: use `waitUntil: "domcontentloaded"`.
- Firefox applies CORS to extension-page fetches to runtime-granted hosts but not manifest `host_permissions`; with `credentials: "include"` the server must send `Access-Control-Allow-Credentials` (OME-683). The lane can't see this: check manually. Always test a POST (Share) from Firefox, not just GET (OME-617).
- Importing `settings.ts` into `background.ts` bundles valibot (7 KB): keep background import-free. Desktop-only manifests always warn `KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION`. `wxt zip -b firefox` sources zip lacks `packages/shared` and `bun.lock`.
- Manual headed check: BiDi allows ONE session (`puppeteer.connect` fails), so keep one launcher that evals a command file; leftover launchers from deleted scratch dirs survive (check `/proc/<pid>/cwd`). Unset `GDK_SCALE`; with no window manager a click inside a Firefox panel dismisses it, so pin the action via the `browser.uiCustomization.state` pref, drive the popup by keyboard, and never `windowfocus` the panel. Map a fake https name with `network.dns.localDomains` plus `acceptInsecureCerts` (the TLS proxy must drop the `host` header). `bringToFront()` doesn't switch tabs in headed Firefox.

**Headless Firefox reports `(hover: none)`** and neither `pointer: fine` nor `coarse` (OME-743). Headed under xvfb it reports hover and fine. The popup's phone block keys on `(hover: none)`, so the `ext:firefox` lane renders the phone layout; prove desktop layout headed under xvfb. Chromium phone emulation uses `--blink-settings=primaryHoverType=1,...` via the `extraArgs` fixture in `e2e/support/extension.ts`.

**Firefox for Android emulator rig** (OME-743; lives in `~/Android`, outside the repo: JDK 21, SDK with `system-images;android-35;default;x86_64`, AVD `ome743` at 1080x2400 and 420 dpi, Fenix APK, `ui.py` adb helper).
- Boot with `-no-window -gpu swangle_indirect`; under `swiftshader_indirect` it hangs.
- Install with `bunx web-ext run -t firefox-android --android-device emulator-5554 --firefox-apk org.mozilla.firefox --source-dir .output/firefox-mv3 --no-reload`, detached.
- Fenix unloads background tabs (reopen and rejoin the room before the popup sees it), reports `(pointer: fine)` and `(hover: none)` (key phone CSS on `hover: none`, not `pointer: coarse`), and `runtime.openOptionsPage()` opens a tab behind the popup sheet (the popup must close itself).
- `adb input text` garbles long strings: clear with `keycombination 113 29` then DEL, and type in short chunks. Back closes the tab when the keyboard is hidden: submit with Enter (keyevent 66).

## Unit-test and code patterns

**Fault-inject `node:fs` with `spyOn`** (OME-370). In Bun, `spyOn(fs, "renameSync")` (with `import * as fs`) also intercepts named imports in production code. Use it instead of test-only parameters, and `mockRestore()` in the test and in cleanup (`apps/server/test/backup.test.ts`).

**Slow-body race test** (OME-506). To test state changes while a Hono route awaits `readBodyCapped`, pass `fetch` a `new ReadableStream<Uint8Array>({ start(c) { controller = c } })`, enqueue part of the JSON, `await Bun.sleep(50)`, change state (for example the owner flips control policy over WS), then enqueue the rest and `close()`. Keep the controller nullable and read it through a helper that throws (no non-null assertions). See `apps/server/test/queue.test.ts`.

**Bound input before regexes** (OME-548). A cap moved after redaction regexes means unbounded input: `EMAIL` backtracks quadratically (200k chars stalled the loop 10-20 s). Keep a pre-regex bound (`MAX_SCRUBBED` in `apps/server/src/log.ts`) and a large-input timing test (200k chars under 100 ms).

**CSS class names are global** (OME-600). `.room-bar` is the personal volume row (`createPersonal`, `style.css`); reusing it shrank the volume slider and only the `phone-layout` e2e "touch targets" caught it (the top bar is `.room-top`). Before adding a class to `apps/web`, grep `className: "<name>"` and the selector in `style.css` and `assets/ui/reference.css`, then run `phone-layout` e2e.
