# M9 sign-off: full suite, flocked perf, deploy, hosted smoke (OME-771)

Everything ran on one SHA: **`main` @ `979e608`** (the OME-857 popup vignettes merge, after all M9 merges: legal pages, 404s and OG cards, site art, help dialog, Hide for me). It ran 2026-10-11 from QA2's clean detached checkout on QA2's ports (4410/5183/8797), headless Chromium. Perf ran under the machine-wide perf lock. That SHA is live on the box.
Raw evidence: [`m9-signoff/`](m9-signoff/) (hosted smoke script and JSON, screenshots, perf report).

| Gate | Result |
|---|---|
| `bun run check` (typecheck, lint, unit) | **5105 pass, 1 skip, 0 fail** (176 files) |
| Full e2e (`CI=1 bun run e2e`) | **306 passed, 0 failed** (4.4 min), incl. `m9-help` and `m9-hide` |
| Flocked perf incl. soak (`flock … bun run perf --soak`) | **135 passed, 0 failed, 0 pending** ([report](m9-signoff/perf-report.md)) |
| Landing budgets | transfer at `/` **48.4 KB gz** (≤ 120), LCP **48 ms** (≤ 1500), CLS **0.013** (≤ 0.05), long task before the nickname field **0 ms** (≤ 50) |
| Deploy `979e608` (`deploy/deploy.sh` as `deploy@`) | live: landing footer shows `version 979e608`, `/healthz` 200 right after. The live box was on `d416fd4`; no migration or `packages/shared` change between them, so no wait for the nightly snapshot |

## Hosted smoke (https://omega-share.duckdns.org, 979e608): 16/16 green

Script: [`m9-signoff/m9-smoke.ts.txt`](m9-signoff/m9-smoke.ts.txt) (scratch, not part of `e2e/**`). Results: [`smoke.json`](m9-signoff/smoke.json). Crawler checks use a `facebookexternalhit` user agent. It created one public and one private room (titles say "m9 signoff"; no operator takedown needed).

| # | Check | Result |
|---|---|---|
| 1a | Landing 200 with the install row, all footer links (privacy, terms, contact, licences, source, feedback) and the build version | pass |
| 1b | `/privacy.html`, `/terms.html`, `/contact.html`, `/licenses.html` each 200 with an h1 and the legal footer | pass |
| 1c | `/nope` and `/nope.html` | 404 both |
| 1d | `robots.txt`, manifest, `og-image.png`, `favicon.ico` | 200 with the right types |
| 2a | Landing in a real browser: renders, install row and footer visible | pass ([screenshot](m9-signoff/landing.png)) |
| 3a | Public room link as a crawler: `og:title` = "<title> · omega-share", `og:image` = our `/og-image.png`, `twitter:card`; `x-robots-tag: noindex, nofollow` | pass |
| 3b | Private room link as a crawler: the title is nowhere in the HTML, `og:title` = "omega-share", and the card tags are byte-identical to the landing's generic card | pass |
| 3c | Unknown room id: generic card, no title | pass |
| 4a | Help dialog in two real contexts (A and B): key opens it (modal, privacy link inside), Esc closes it, focus returns to the key | pass ([A](m9-signoff/help-A.png), [B](m9-signoff/help-B.png)) |
| 4b | Hide for me: A hides B (row says hidden, status "m9-b is hidden for you. Only you see this."), B still sees A, Show undoes it | pass ([screenshot](m9-signoff/hide-A.png)) |
| 5 | No CSP violations or page errors in any browser | 0/0 |

## Findings and notes

- **Install links are not links yet.** The landing's install row says "Firefox: coming soon · Chrome: coming soon" on the hosted site, so there are no install links to check. This matches `landing.e2e` (it asserts "coming soon"), but if M9's intent was live store links, the CEO should know: they depend on the AMO/Chrome listings going live and the build env that fills the row.
- **Not tested with a real third-party unfurl tool.** The OG check is the hosted HTML fetched as a crawler (the acceptance's required form); no external preview service was used.
- **Uptime monitor (S2): no false "down", but the restart was not itself observed.** The off-box monitor (`omega-share-monitor.timer`, every 5 min) ticked at 04:25:21 CEST and 04:30:21 CEST. The deploy restart happened at 04:25:32–36 CEST, in the gap between ticks, so no tick saw it. Both ticks and the state file (`health=up`, `fails=0`) show no failure was recorded and no push was sent. By design a "down" push needs 2 failures in a row, 5 min apart, and the graceful restart (ADR 0032) is back in about 4 s (`/healthz` 200 right after the deploy returned), so a deploy cannot trip it. A tick landing inside the restart would count one failure and reset on the next. I did not force a mid-restart tick.
