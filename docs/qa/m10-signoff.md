# M10 sign-off: full suite, flocked perf (both tiers + soak), deploy, hosted phone smoke (OME-913)

Everything ran on one SHA: **`main` @ `d79743f`** (the OME-912 Q1 merge, after all M10 merges: phone composer, portrait dock, presets and saved layouts, durable sessions, room cleanup). It ran 2026-10-13 from QA2's clean detached checkout on QA2's ports, headless Chromium for the suites and **headed Chromium on xvfb** for the hosted smoke. Perf ran through the perf runner (one job per motion tier) and, for the soak, under the machine-wide perf lock. That SHA is live on the box.
Raw evidence: [`m10-signoff/`](m10-signoff/) (perf reports, smoke script and JSON, screenshots).

| Gate | Result |
|---|---|
| `bun run check` (typecheck, lint, unit) | **5365 pass, 1 skip, 0 fail** (196 files) |
| Full e2e (`CI=1 bun run e2e`: e2e, e2e-sync, e2e-tunnel) | **434 passed, 0 failed, 0 flaky** (5.1 min) |
| Flocked perf, Smooth tier (job `1791846500505-2wu34s`) | **134 passed, 0 failed, 1 pending** (soak) — [report](m10-signoff/perf-report-smooth.md) |
| Flocked perf, Basic tier (job `1791846500528-1twj9e`) | **134 passed, 0 failed, 1 pending** (soak) — [report](m10-signoff/perf-report-basic.md) |
| Flocked perf with soak (`flock … bun run perf --soak`, unforced tier) | **135 passed, 0 failed, 0 pending** — [report](m10-signoff/perf-report-soak.md). 10 min heap soak: **5.6 MB** (start 4.5 → end 5.6 MB; ≤ 150) |
| Deploy `d79743f` (`deploy/deploy.sh` as `deploy@`) | live: landing footer shows `version d79743f` (was `979e608`), `/healthz` 200 |
| Hosted phone smoke (headed, xvfb, 390×844 touch) | **all five board scenarios pass**, with two script fixes and one caveat (below) |

## Perf on d79743f (budgets in `docs/perf-budgets.md`)

- **Walking on a phone, 8 avatars + each provider** (Basic tier): frame p95 16.7 ms, main thread p95 4.3–5.1 ms (≤ 8), 0.0 % missed vsyncs (generic embed: 1 of 299 frames, 0.3 %).
- **Relay:** control 0.9 ms, under flood 1.0 ms; 25 in a room with traffic p95 2.4–2.5 ms (≤ 50).
- **Extension popup:** Chromium 55–64 ms, Firefox 87–90 ms (≤ 300).
- **Landing:** transfer at `/` **72.5–72.7 KB gz** (≤ 120), LCP 52 ms, CLS 0.023–0.041 (≤ 0.05), longest task 0 ms. **Watch item (not a budget miss):** up from 48.4 KB at M9 (+24 KB) because the preset thumbnails and chunks load eagerly on `/` ([OME-912](/OME/issues/OME-912)). 47 KB of headroom remains.
- **Soak:** 5.6 MB after GC (M8: 5.6 MB, M7: 5.3 MB), so the durable-session and room-cleanup state added no leak.

## Hosted smoke (https://omega-share.duckdns.org, d79743f)

Script: [`m10-signoff/m10-smoke.ts.txt`](m10-signoff/m10-smoke.ts.txt) (scratch, not part of `e2e/**`). Results: `smoke-main.json`, `smoke-tab.json`, `smoke-gc.json`. It made real rooms through the create form (titles "m10 signoff …"); the public ones are already gone from `/rooms`, and the private ones expire on their own by about 01:15 UTC, so no operator takedown is needed.

| # | Scenario | Result |
|---|---|---|
| 1 | **Create from a preset** on a phone: the picker lists all 6 presets (classic, cinema, living, lounge, cafe, empty) with classic checked; creating from "cinema" lands in the room | pass ([form](m10-signoff/1-create-form.png), [room](m10-signoff/1-room-from-preset.png)) |
| 2 | **Portrait docked composer:** chat field and Link key are inside the first screen, the page doesn't scroll (390×844), a line sends | pass ([screenshot](m10-signoff/2-portrait-dock.png)) |
| 2b | **Share sheet:** Link opens it with the URL field focused; URL field, Add and Close are all ≥ 44 px; Esc closes | pass ([screenshot](m10-signoff/2b-share-sheet.png)) |
| 3 | **Full-screen composer** (667×375 landscape, real fullscreen element): the field is 147 px = 75 % of its row (≥ 140 px and ≥ 60 %), Send is 44×44, `enterkeyhint=send`, Enter and a tap on Send both send, focus stays in the field | pass ([screenshot](m10-signoff/3-fullscreen-composer.png)) |
| 4 | **Tab out 60 s, return seated:** seated in seat 3, backgrounded and frozen for 60 s, back: still seat 3 as "yours", no Enter form, the peer saw the member go Away and come back, no leave/join line in the peer's chat | pass ([screenshot](m10-signoff/4-back-seated.png)) |
| 5 | **No CSP violations or page errors** in any browser | 0 |
| 6 | **Empty room disappears after 20 min:** public room B joined, then its only member left (00:29:54 UTC). B was still in `/rooms` at 19 min and gone by about **22.2 min** (a 2 min resume hold, then the 20 min rule, then a ≤ 1 min sweep). `/r/<B>` shows "This room doesn't exist or was taken down" | pass ([screenshot](m10-signoff/6-room-gone.png)) |

## Caveats and script fixes (none is a product defect)

- **First run of scenario 4 failed, and it was the script.** Room A was private, and a guest needs the `#k=` invite key; the peer opened the bare `/r/<id>` and got the not-found screen. The `smoke-main.json` row shows that failure. The rerun (`PHASE=tab`) used a second private room and the invite link. (Scenarios 1–3 passed in that first run.) The same screen confirmed that a private room without its key is unreachable.
- **"Tab out" is simulated lifecycle plus a real freeze, not a real hidden tab.** Chromium on xvfb has no window manager, and a background tab in the same window stayed `visibilityState = visible` after `bringToFront` on another tab. So the page was sent `visibilitychange` (hidden) and `pagehide`, as `e2e/m10-sessions.e2e.ts` does, and then frozen with CDP `Page.setWebLifecycleState` for 60 s, which stops its timers and socket work the way a phone OS does. The server side (grace hold, token resume) is the real one on the box. It has **not** been tried on a real phone's OS-level backgrounding.
- **`smoke-gc.json` shows one FAIL row, and it is the script's text matcher.** The poll loop had already seen B listed at 19 min and gone before 26 min; the last wait looked for the words "Room not found", but the screen says "This room doesn't exist or was taken down". I fixed the matcher in the committed script and checked the screen by hand ([screenshot](m10-signoff/6-room-gone.png)).
- **Scenario 6 timing:** the room was reaped at about 22 min, not 20, by design (ADR 0028/0043: the 2 min resume hold before the room counts as empty, plus the 1 min sweep). A member who closed their tab still counts as present during the hold (`/rooms` showed `memberCount: 1` right after).
- **Create limit while testing:** 2 creates per 10 min per client; the limiter made the script retry timing matter. Not a defect, but a failed smoke costs 10 min.
- **Preset content not compared to the layout on the box.** The smoke checks that the picker offers all six presets and that a preset create lands in a working room; the layout equality per preset is covered by `e2e/room-presets.e2e.ts` (in the 434).
- **Not tested:** a real phone (touch emulation only, as in all milestones), and real-provider playback (no M10 change touches provider code; the `e2e-real` lane was not run for this sign-off).

## Verdict

M10 passes sign-off on `d79743f`: all gates green, deployed, and the five board scenarios work on the hosted site. The CEO can report to the board.
