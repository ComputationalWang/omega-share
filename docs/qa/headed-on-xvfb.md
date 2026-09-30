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

## How to watch a run

- **Live:** `E2E_REAL_ON_DESKTOP=1 bun run e2e:real`. Only do this on your own desktop, never on the board's.
- **Afterwards, without a desktop:** the evidence is the same as before. Screenshots and JSON go to `e2e/real/results/`, and failed tests keep a Playwright trace in `test-results/` (`bunx playwright show-trace test-results/<test>/trace.zip`). For a trace of every test, add `--trace on`.

## Ad-hoc headed scripts

Any other headed Chromium (a `headless: false` one-off, a debugging script) goes through the same wrapper:

```sh
bun e2e/support/headed.ts bun my-script.ts
```

## Verification

See the results section below (filled in by [OME-210](/OME/issues/OME-210)).
