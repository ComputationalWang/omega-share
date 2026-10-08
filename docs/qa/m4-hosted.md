# M4 hosted QA: https://omega-share.duckdns.org ([OME-360](/OME/issues/OME-360))

QA Engineer 2, 2026-10-08, 17:05–18:05 UTC, from the QA box (one residential address, ~16 ms from the box). Every browser run was headless or headed on Xvfb (`e2e/support/headed.ts`). `hyprctl clients` showed no "Google Chrome for Testing" window after each headed run. Local helpers ran on QA2's alt ports (4410/5183/8797).

**Deployed revision: `9f2e8498e37fae4c3c3b5f1be718e23076e51a4c`** (`main@9f2e849`, OME-363). `/opt/omega-share/current` points to that release ([OME-375](/OME/issues/OME-375)). This agrees with what is visible from outside: the site bundle (`index-geJTK_y0.js` / `index-8HHdnAtf.css`) is unchanged since `48cc7b8`, and the enforced TT and HSTS headers mean the server is ≥ `9995b63`.

**Verdict: green, with one known issue.** Caddy's error log writes client IPs when the upstream is down (§6). The Lead filed it as [OME-386](/OME/issues/OME-386). Restart persistence was not observed (§7). Test-harness gap: [OME-378](/OME/issues/OME-378) (QA Engineer, not blocking).

## 1. Hosted smoke (4 browsers, headless)
Scratch script `smoke.ts` (attached to OME-360). It drives the real UI like the e2e specs do: same `data-testid` contract, `clickSettled` for seats.

| check | result |
|---|---|
| 4 clients join the lobby, each with its own avatar | pass. Landing → room in 525–610 ms |
| every client sees all 4 nickname tags | pass |
| sit: each in its own seat; A sees seats 1–3 `taken by qa2-m4-2/3/4` | pass |
| chat: A's line shown on all 4 | pass. 47–57 ms after send |
| share YouTube `aqz-KE-bpKQ` with A's share token → embed on all 4 | 200. Embed shown in 135–141 ms |
| sync over the wire: A's click → `playback` frame at every client | pause **205–207 ms**, play **118–119 ms**, seek **24 ms**. All within 500 ms. Click times include Playwright's scroll-and-two-frames settle |
| generic tier: share `https://example.com/` | 200. Card on all 4 in 51–92 ms, `not-synced` shown, **0 requests to example.com before Load** on any client |
| after Load on A | one iframe for example.com with the fixed sandbox and `referrerpolicy=no-referrer`. The other 3 still made 0 requests |
| Trusted Types enforced in the live page | `innerHTML = "<b>x</b>"` throws `TypeError` |
| CSP / Trusted Types violations from the app | **0** on all 4 clients. The one violation logged on A is the deliberate probe above |

Restart persistence: see §7.

## 2. Informational perf (not merge-blocking: the network isn't ours)
| | value |
|---|---|
| ICMP RTT, 20 packets | min/avg/max **15.1 / 16.4 / 29.9 ms**, 0 % loss |
| `/healthz` over HTTP/2 | connect 18–19 ms, TLS 40–45 ms, TTFB 57–64 ms |

Relay latency: `apps/server/src/relay-latency.ts --url wss://omega-share.duckdns.org/rooms/lobby/ws --origin https://omega-share.duckdns.org --clients 5`, under the perf flock. Each figure is the time until every socket sees the event, so it includes one RTT.

| action | runs × samples | p50 | p95 |
|---|---|---|---|
| sit/stand (`seat-changed`) | 4 × 16 | **16–18 ms** | **18–27 ms** |
| control (`playback`) | 2 × 19 | **17–19 ms** | **24–27 ms** |

These match OME-364's run on `be73dbb` (sit p95 20–35 ms, control 22–43 ms). The probe needs ≤ 5 clients per address and **~40 s between batches** against the hosted limits (5 members per address, join burst 6, then 1 per 5 s). With 30 s between batches, three batches right after the smoke failed to join. That is the limiter working, not a defect.

## 3. Real providers, two headed browsers on Xvfb, hosted origin
| provider | source | spread |
|---|---|---|
| YouTube `aqz-KE-bpKQ` (extension share → viewer) | `real-tunnel.real.ts` tunnel-2 | steady: first sample −159 ms, then ≤ 13 ms (12 samples, max \|spread\| 159). After pause/play **12 ms**. Paused diff **0 ms**. `origin` = hosted origin |
| Twitch VOD `2784566594` | tunnel-2 | share 200. `parent` = `omega-share.duckdns.org`. Steady max \|spread\| 359 ms (first sample), then a constant **−193 to −198 ms** offset |
| **Twitch live** `chynao_o` (Just Chatting, picked live from the directory; the 5 default candidates were offline) | scratch `providers.ts` (M2-twitch-live method: arrival spread, live has no comparable position) | pause spread **156 / 112 / 155 ms**, play spread **52 / 105 / 106 ms** over 3 rounds. LIVE pill shown, no scrubber, both playing at the end |
| Vimeo `1084537` | scratch `providers.ts` | steady **22 ms**. Paused diff **0 ms**. After play **52 ms**, settled **42 ms** |

**Twitch live spread** (known gap): worst **156 ms** this run, against **201 ms in M3**. Every spread above is under the 500 ms bound.

tunnel-1 also passed: health 200, chat delivered, page on https, no mixed content. Tunnel-3 is skipped against the box, as hosting.md says.

## 4. Real pre-roll attempt (known gap): **ads were served for the first time**
Run: a scratch copy of `e2e/real/real-ads.real.ts` with DOM-based room state (the spec needs `window.__omega`, which production builds don't ship; see [OME-378](/OME/issues/OME-378)). Two fresh, logged-out raw-CDP Chromium profiles (no Playwright user activation), hosted lobby, 17:43–17:51 UTC.

| # | attempt | ad on A / B | ad length | room ever paused | after |
|---|---|---|---|---|---|
| 1–8 | YouTube `dQw4w9WgXcQ`, `kJQP7kiw5Fk`, `JGwWNGJdvx8`, `OPf0YbXqDm0`, `0e3GPea1Tyg`, `2Vv-BfVoq4g`, `RgKAFK5djSk`, `YQHsXMglC9A` (30 s each) | no / no | – | no | both playing, 0–36 ms apart at 30 s |
| 9 | Twitch live `chynao_o` | **yes / yes** | **12.5 s** each (pre-roll) | **no** | both playing content, catching tags clear |
| 10 | Twitch live `ohnepixel` | **yes / yes** | **136 / 133.5 s** (streamer ad break, "Ad (1:58)") | **no** | same |
| 11 | Twitch live `kprlol` | **yes / yes** | **11.5 s** each (pre-roll) | **no** | same |

Plus the earlier `providers.ts` Twitch run: `chynao_o` again showed an ad label for ~14 s before content.

- **YouTube:** 0 of 8. Combined with M3's 0 of 16, embedded YouTube has served 0 pre-rolls to this viewer in 24 attempts.
- **Twitch live:** 3 of 3 served (M3: 0 of 6). The room stayed LIVE and never paused through each ad, and both members returned to content on their own.
- Both members got the ad at the same time, so the "other member sees the catching-up tag" case (OME-101) still isn't exercised with a real ad. It needs one member in an ad and the other not. The fake-SDK ad cases remain the regression guard for it.
- Screenshot `m3-ad-m4-tw-ohnepixel-a-ad.png` shows the Twitch ad overlay inside our TV with the room's LIVE chrome underneath.
- Every attempt's JSON and both members' screenshots (`m3-ad-m4-*`, `m3-ads-m4.json`) are attached to OME-360.

## 5. Extension → hosted origin
- **tunnel-2:** the e2e build with `serverBaseUrl` = the hosted origin (the value the popup settings store) shares from the fixture page. The viewer watches in sync (§3).
- **Real third-party page** (scratch `ext-real.ts`): `https://mango.blender.org/` has 3 YouTube oEmbed iframes. The popup listed all 3 (`YouTube · oXzYqf_fuw4`, `1V_yHduTFE8`, `41hv2tW5Lc4`). Share → **"Shared to lobby."** (`data-state=ok`). The hosted room loaded `youtube-nocookie.com/embed/oXzYqf_fuw4`.
- **Limit:** the optional host permission and `activeTab` were applied to the unpacked copy's manifest, because Playwright can't click Chrome's permission prompt. The runtime grant flow stays covered by unit tests (OME-130). No extension code change is needed, so nothing was filed for the Extension Engineer.

## 6. Safety from outside
| check | result |
|---|---|
| HSTS | `strict-transport-security: max-age=31536000` on `/` |
| CSP | one header CSP: `require-trusted-types-for 'script'; trusted-types omega-sdk youtube-widget-api`, `frame-ancestors 'none'`, `object-src 'none'`, `frame-src … https:` (generic tier). No report-only header. TT enforced in the page (§1) |
| 429 + `Retry-After` on an HTTP burst | 400 × `GET /healthz` over one HTTP/2 connection: **131 × 200, 269 × 429**, every 429 with **`Retry-After: 1`**. `/healthz` was back to 200 after 8 s. tunnel-4: 20 × 401 then 10 × 429 with a fresh spoofed `X-Forwarded-For` each time |
| ports | TCP **22, 80, 443 open**. **8787, 2019 (Caddy admin), 3000, 5173 closed/filtered** |
| no IP addresses in the server logs | **app: pass.** `journalctl -u omega-share` since 16:00 UTC: 89 lines, 6 IP-shaped matches, all the loopback bind line `server on http://127.x.x.x:8787/`. No client IP, and the window covers QA2's bursts, refused tokens, joins and shares. **Caddy: known issue [OME-386](/OME/issues/OME-386).** 188 lines, 13 matches: 5 ACME validators, 3 loopback admin lines (before admin was turned off at 16:37), and **5 `http.log.error` 502 entries with a real client `remote_ip`/`client_ip` and headers** (16:12–16:16, app down during deploys). None of them fall in QA2's window. The access log is off ([OME-375](/OME/issues/OME-375), board run 18:22 UTC) |

## 7. Restart persistence: not observed
- The board ran `systemctl restart omega-share` (as `deploy`) at **2026-10-08T18:22:25Z**. The service came back `active` and `/healthz` returned 200 ([OME-375](/OME/issues/OME-375)).
- Before the restart, QA2 had left the lobby on Vimeo `1084537`. At 18:24:18Z, a WS join snapshot from outside showed the lobby on **Twitch live `shroud`**: `action: load`, rev 3, `at` 18:23:39Z, 1 member. Another client shared it 74 s after the restart, most likely the parallel QA run on [OME-378](/OME/issues/OME-378), whose candidate list contains `shroud`. So the snapshot can't show whether the Vimeo embed survived the restart.
- Coverage meanwhile: `e2e/persistence.e2e.ts` (restart of a real server keeps rooms, layouts and the last embed, paused at 0) and the OME-358 restore drill.
- A before/after probe that one person can run around a single restart is with the Lead in the review issue.
