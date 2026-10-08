# Headed Chromium on a virtual display (Xvfb)

[OME-210](/OME/issues/OME-210), board rule from [OME-209](/OME/issues/OME-209).

## Why

The real-provider checks (`bun run e2e:real`: YouTube, Twitch, Vimeo, the tunnel) run **headed**, because real players can behave differently in headless Chromium (autoplay, media pipeline, ads). On the shared machine, headed windows opened on the board's desktop and stole focus. Now they open on an off-screen X server (Xvfb). They are still headed, just not visible.

The host is a Wayland session (`OZONE_PLATFORM=wayland`, `XDG_SESSION_TYPE=wayland`, `WAYLAND_DISPLAY` set), so a plain `xvfb-run` isn't enough: Chromium still tries Wayland and fails with "Failed to connect to Wayland display". The wrapper applies the board's recipe:

```sh
env -u WAYLAND_DISPLAY -u ELECTRON_OZONE_PLATFORM_HINT -u XDG_BACKEND OZONE_PLATFORM=x11 XDG_SESSION_TYPE=x11 xvfb-run -a <command>
```

It also passes `-s "-screen 0 1920x1080x24"`, because xvfb-run's default 640×480 screen is smaller than the 1280×720 Desktop Chrome viewport.

## How it works

- `e2e/support/headed.ts` is the wrapper: `bun e2e/support/headed.ts <command> [args…]`. The planning logic (argv, env, fallback) is in `e2e/support/xvfb.ts` and unit-tested in `e2e/support/xvfb.test.ts`.
- `bun run e2e:real` is `bun e2e/support/headed.ts playwright test --project=e2e-real`. Extra args pass through: `bun run e2e:real -g "M2-vimeo"`.
- Every headed launch inside the run (the `e2e-real` project's own browser, the `chromium.launch({ headless: false })` pairs, the extension's `launchPersistentContext`, and the raw-CDP Chromium in YouTube item 3) is a child of that process, so it inherits the virtual display.
- Guard: each real spec has `test.beforeAll(requireVirtualDisplay)` (`e2e/real/real.ts`). If you run `playwright test --project=e2e-real` directly, without the wrapper, the specs fail before any browser starts, and the error tells you what to run instead.

## Env vars

| Var | Effect |
|---|---|
| `E2E_REAL_ON_DESKTOP=1` | Opt out: run on your real desktop so you can watch. The wrapper prints a one-line notice. |
| `OMEGA_HEADED_DISPLAY` | Set by the wrapper (`xvfb`, `desktop` or `fallback`), and read by the guard. Don't set it yourself. |

If `xvfb-run` isn't installed, the wrapper falls back to the old behavior (windows on the desktop) and prints `headed: xvfb-run not found …` with the package to install (Arch: `xorg-server-xvfb`, Debian/Ubuntu: `xvfb`).

## Against a hosted origin (production build)

The real specs can target a deployed site instead of the local dev servers ([OME-378](/OME/issues/OME-378)). Point both URLs at the origin; Playwright then finds them answering and starts no local web or game server:

```sh
OMEGA_WEB_URL=https://omega-share.duckdns.org OMEGA_SERVER_URL=https://omega-share.duckdns.org \
  bun e2e/support/headed.ts bunx playwright test --project=e2e-real e2e/real/real-ads.real.ts
# Twitch live and Vimeo, same origin:
OMEGA_WEB_URL=https://omega-share.duckdns.org OMEGA_SERVER_URL=https://omega-share.duckdns.org \
  bun e2e/support/headed.ts bunx playwright test --project=e2e-real e2e/real/real-providers.real.ts -g "M2-vimeo|M2-twitch-live"
```

- `ROOM_URL`, `shareUrl` and `joinForToken` follow the two URLs; the share carries no `Origin`, which the server allows (ADR 0015).
- A production build has no `window.__omega`. `e2e/real/room-view.ts` then reads the room from the page: *playing* from the play key's label ("Pause for everyone"), *catching* from my own tag (`nickname-tag.self.catching`), *live* / *seekOnly* from the live pill and the "syncs by skipping" hint, *canControl* from the play key being enabled, and *error* from the sync notice's text. Join is ready once the document has loaded and `main.ts` has run (the avatar options get their `tabindex` in the same pass that wires Enter). `e2e/room-view.e2e.ts` keeps the DOM reading equal to `__omega` on a dev build.
- Still dev-only: `real-youtube.real.ts` (it reads `hasVideo`, `needsUnmute` and the volume, which the DOM doesn't show).
- The hosted box rate-limits joins and shares: keep to a few clients and narrow the run (`OMEGA_REAL_AD_YT`, `OMEGA_REAL_AD_TWITCH`, `-g`). Everything shared lands in the public lobby.

## How to watch a run

- **Live:** `E2E_REAL_ON_DESKTOP=1 bun run e2e:real`. Only do this on your own desktop, never on the board's.
- **Afterwards, without a desktop:** the evidence is the same as before. Screenshots and JSON go to `e2e/real/results/`, and failed tests keep a Playwright trace in `test-results/` (`bunx playwright show-trace test-results/<test>/trace.zip`). For a trace of every test, add `--trace on`.

## Ad-hoc headed scripts

Any other headed Chromium (a `headless: false` one-off, a debugging script) goes through the same wrapper:

```sh
bun e2e/support/headed.ts bun my-script.ts
```

## Verification

### 2026-09-30 · branch `qa-engineer/OME-210-xvfb` on `main` @ 186c13f · Chrome for Testing 153 (Playwright 1.63.0), headed on Xvfb 1920×1080×24 · QA ([OME-210](/OME/issues/OME-210))

`bun run e2e:real e2e/real/real-youtube.real.ts e2e/real/real-providers.real.ts --trace on`, then Twitch again with `-g M2-twitch --repeat-each 2`. A `hyprctl clients` poll every 2 s through both runs (548 samples) saw 3 desktop windows the whole time and never a Chromium one.

| Check | Result on Xvfb | Before (headed on Wayland, `docs/qa/m1b-real-youtube.md`, `m2-real-sign-off.md`) |
|---|---|---|
| Guard | `playwright test --project=e2e-real` without the wrapper fails in `beforeAll`. `DEBUG=pw:browser` shows 0 browser launches. | n/a |
| YouTube 3a sound after Enter | PASS: `muted: false`, volume 1, `needsUnmute: false` | PASS, the same |
| YouTube 3b muted fallback (raw CDP) | PASS: `hasBeenActive: false`, muted and playing, Unmute shown, unmuted after the click | PASS, the same |
| YouTube 2, 4, 5, 6, 8 | PASS. 5: slope 1.050, rung `fine`. 6: 172 ms throttled. 8: widget 200, 0 CSP violations | PASS: 1.050 `fine`, 168 ms, 200/0 |
| YouTube 7 two browsers | PASS: steady 113 ms, pause 0 ms, 27 ms after play | PASS: 182 ms, 0, 38 |
| YouTube 1 pre-roll | Skipped, no ad served (the known gap) | The same |
| Twitch VOD (P1) | 1st run FAIL: after-seek 809 ms (one client −809 ms, 5 samples after the seek). Reruns 2/2 PASS: 112 / 0 / 61 / 108 ms | PASS: 286 / 0 / 1 / 3 ms |
| Twitch live (P3) | 1st run FAIL: `valorant` was offline. With `OMEGA_REAL_TWITCH_LIVE=caedrel` 2/2 PASS: pause spread 58 ms, play 57 ms, LIVE pill, no scrubber | PASS: 57 / 262 ms |
| Vimeo (P2) | PASS: 24 / 0 / 31 / 28 ms, `seekOnly: false` | PASS: 124 / 0 / 16 / 26 ms |
| Refused (P4) | PASS | PASS |
| Extension load | Headed `launchPersistentContext` with the e2e build: the service worker started and the popup rendered | T2 (needs a tunnel, not rerun) |

Differences we saw:
- The raw-CDP Chromium (YouTube 3b) has no Playwright viewport, so its window fills the Xvfb screen and its screenshots are bigger (2560×1714) than on the desktop.
- There's no GPU on Xvfb, so video decodes and draws in software. Every real player still played and seeked, and the spreads stayed in the Wayland range. The one Twitch after-seek spike didn't repeat in 2 reruns, so we treat it as a flaky real player, not an Xvfb effect. If it comes back, compare with `E2E_REAL_ON_DESKTOP=1` on a desktop you own.
- `xvfb-run -a` picks a free display (`:99`, `:100`, …), so runs can overlap without clashing.
