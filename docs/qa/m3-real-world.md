# M3 real-world checklist: a real pre-roll attempt and abuse over ngrok (QA; rerun at each milestone)

CI never touches the real providers or a real tunnel. The fixture suites prove the logic: the fake-SDK ad cases (`e2e/sync.e2e.ts`, `e2e/provider-sync.e2e.ts`), the proxy abuse suite (`e2e/abuse.e2e.ts`, [OME-191](/OME/issues/OME-191)) and the server unit tests (`apps/server/test/abuse.test.ts`, `share-token.test.ts`). This checklist checks that the real players and a real public tunnel behave the way those suites assume. It extends [`m2-real-sign-off.md`](m2-real-sign-off.md). Owner: QA ([OME-194](/OME/issues/OME-194)).

## How to run

```sh
bun run --filter @omega/web build
bun run e2e:real -- real-ads          # Part A, ~9 min; dev servers on 5173/8787 as for the other real specs
OMEGA_REAL_AD_WARM=1 OMEGA_REAL_AD_TAG=-warm bun run e2e:real -- real-ads   # Part A again, profiles warmed on youtube.com first

# Part B: claim the ngrok session in the Coordination doc (OME-1) first, and stop it right after.
ngrok http 127.0.0.1:8807                                            # read the https host from the Forwarding line / :4040 API
PUBLIC_ORIGIN=https://<host> TRUST_PROXY=loopback HOST=127.0.0.1 PORT=8807 STATIC_DIR=$PWD/apps/web/dist bun apps/server/src/index.ts
OMEGA_REAL_TUNNEL_ORIGIN=https://<host> OMEGA_REAL_TUNNEL_PORT=8807 bun run e2e:real -- real-abuse   # ~1 min
```

- Specs: `e2e/real/real-ads.real.ts` (Part A) and `e2e/real/real-abuse.real.ts` (Part B). They run headed on Xvfb (`docs/qa/headed-on-xvfb.md`). Evidence goes to `e2e/real/results/m3-*.json` / `.png` (git-ignored).
- **Part A doesn't use Playwright's browser.** Playwright gives every page a user activation, which a real visitor doesn't have. So the spec spawns two Chromium processes itself, each with a fresh, logged-out profile, no extensions and the default autoplay policy, and drives them over raw CDP (`rawTab` in `real.ts`). The join click is a trusted CDP mouse event, like a user's. Each provider iframe is read through its own CDP target (site isolation). `OMEGA_REAL_AD_BROWSER` selects another Chromium binary, and `OMEGA_REAL_AD_YT` / `OMEGA_REAL_AD_TWITCH` override the candidate lists.
- **Part B runs over one public address.** Every client on this machine reaches the server as one address (the XFF entry that ngrok appends), the honest pair included. So each case uses a small volume, the cases run in an order that leaves the per-address buckets enough room, and every case ends with an honest-pair play/pause check. The whole run sends about 90 requests through the tunnel.

## Checklist

| # | Check | Pass when |
|---|---|---|
| A | **Real pre-roll.** 2 raw-CDP logged-out profiles in the lobby. At least 5 monetised YouTube videos, then Twitch candidates until 3 are live. Each is watched for 30 s, and an ad break is waited out (up to 150 s). A youtube.com watch-page control runs last. | If an ad is served: the room never pauses, the other member sees the ad-watching member's catching-up tag ([OME-101](/OME/issues/OME-101)), and after the ad the two players are back within 500 ms (VOD), or the tag clears (live). If no ad is served, every attempt is recorded and the gap is stated. |
| B0 | **Zero CSP violations** with a real Twitch VOD, Vimeo and YouTube, in 2 browsers over the tunnel | The page has the strict CSP header. All three play in both browsers. No enforced violation in our documents and no CSP console error (the `csp` fixture, [OME-191](/OME/issues/OME-191)). |
| B1 | **Hostile name and chat**: a raw join as `<img src=x onerror=…>`, and that string plus a `<script>` sent as chat | The join gets `error: bad_message` and stays unjoined, with no tag. The chat shows the literal text: no `img`/`script` element, nothing runs. |
| B2 | **Oversize frame**: one 4097-byte frame | That socket closes with 1006. `/healthz` is still 200. |
| B2b | **Message flood**: a joined socket sends 80 chats at once | `rate_limited`, then close 4029 |
| B3 | **Share-token replay** | A live token from `Origin: https://example.com` gets 403. After its member leaves, the same token gets 401 `unauthorized`. |
| B4 | **Share spam**: shares with a spoofed XFF on each | The room's switch limit answers 429 `rate_limited` with `Retry-After` and `retryAfterMs` |
| B5 | **Spoofed `X-Forwarded-For`**: 25 unauthorized shares, each with a new XFF | 20 (plus refill) × 401, then 429: ngrok appends the real address, so spoofing gives no fresh buckets |
| B6 | **Connection flood**: raw joins until the per-address member cap, then a sequential upgrade loop, then one upgrade with a spoofed XFF | The 6th member from the address (the honest pair are 2 of the 5) gets `too_many_members`. The loop gets 429 `reconnecting too fast` with `Retry-After`, and so does the spoofed upgrade. The honest pair stays connected. |
| all B | **Honest pair**, after every case: A presses play/pause | Both real YouTube players follow, with a spread ≤ 500 ms (Sync row, `docs/perf-budgets.md`) |

## Results

Newest first.

### 2026-09-30 22:07–22:32 UTC · `main` @ 5f097ae · Chrome for Testing (Playwright 1.63.0), headed on Xvfb · QA ([OME-194](/OME/issues/OME-194))

#### Part A: known gap. No real pre-roll was served in the room. The watch-page control *was* served one.

32 room attempts over two runs (22 of them played: 8 YouTube + 3 live Twitch per run), with 0 ads in the room. On the same address and profiles, minutes later, youtube.com served a real pre-roll: a "Sponsored" 20 s ad on `dQw4w9WgXcQ`, 4 of 4 times (`kJQP7kiw5Fk`: 0 of 2). So ads reach this viewer on youtube.com but not in embedded players. It isn't the nocookie host either: M2 Y1 saw 0 of 10 on a `www.youtube.com` embed too. Coverage stays the fake `ad(ms)` / Twitch ad fakes, which remain the regression guard.

| Run | Profiles | YouTube in the room (30 s each, both members) | Twitch live (30 s each) | youtube.com watch-page control |
|---|---|---|---|---|
| 1 (22:07) | fresh, never visited youtube.com | 0 / 8 ads. Every one played content in both, 1–55 ms apart at 30 s. | 0 / 3 ads (`xqc`, `shroud`, `summit1g`). Offline: `valorant`, `caedrel`, `esl_csgo`, `riotgames`, `kaicenat`. | **ad** on `dQw4w9WgXcQ` ("Sponsored", 0:20). None on `kJQP7kiw5Fk`. |
| 2 (22:19) | fresh, then warmed on a youtube.com watch page (both got the ad there) | 0 / 8 ads, 3–63 ms apart at 30 s | 0 / 3 ads (the same 3 live, the same 5 offline) | **ad** on `dQw4w9WgXcQ`, none on `kJQP7kiw5Fk` |

YouTube ids, all monetised uploads from large channels: `dQw4w9WgXcQ`, `kJQP7kiw5Fk`, `JGwWNGJdvx8`, `OPf0YbXqDm0`, `0e3GPea1Tyg`, `2Vv-BfVoq4g`, `RgKAFK5djSk`, `YQHsXMglC9A`. Per-attempt start time, what each player showed at the end (`currentTime`, paused, ad, overlay text) and screenshots are in `m3-ad[-warm]-<yt|tw>-<id>.{json,png}` and `m3-ads[-warm].json`. The watch-page control is in `m3-ad[-warm]-control-*.png`.

Side finding (not an ad): **the Twitch mature gate was seen for the first time.** `xqc` (live, "Mature-rated game") showed Twitch's "Just one second… This content may not be appropriate… *Start Watching*" interstitial in both members' players, while the `<video>` behind it was advancing. The room showed LIVE and no notice, so each member has to click *Start Watching* inside the player. M2 P4 recorded this gate as "not observed". Filed as a follow-up (not a blocker, not an abuse fail). Evidence: `m3-ad-tw-xqc-{a,b}.png`.

#### Part B: PASS, 8 / 8, twice (ngrok free plan, fixed dev domain; session 22:28–22:32 UTC, stopped right after)

| # | Result | Run 1 | Run 2 | Same as the fixture suite |
|---|---|---|---|---|
| B0 | **PASS** | Twitch VOD `2784566594`, Vimeo `1084537` and YouTube `aqz-KE-bpKQ` played in both. 0 enforced violations, 0 CSP console errors, 0 third-party. No Twitch pre-roll. | same | yes (`csp` fixture) |
| B1 | **PASS** | join → `error:bad_message`, no tag. Chat rendered as literal text, 0 `img`/`script`, `__pwned` unset. | same | yes (`NicknameSchema`, fuzz corpus) |
| B2 | **PASS** | close 1006, `/healthz` 200 | same | yes (`[Oversized frames]`) |
| B2b | **PASS** | `snapshot`, `chat`, `error:rate_limited`, close 4029 | same | yes (`[Sustained flood never escalated]`) |
| B3 | **PASS** | foreign Origin 403. After leave, 401 `{"code":"unauthorized"}`. | same | yes (T-02, `tunnel-3`) |
| B4 | **PASS** | 200, then 429 `rate_limited`, `Retry-After: 10`, `retryAfterMs: 10000` | same | yes (room switch limit, `abuse.e2e.ts` share spam) |
| B5 | **PASS** | 21 × 401, then 4 × 429 (one refill token at 1/s) | same | yes (M2 T4) |
| B6 | **PASS** | squat: 3 × `snapshot`, then `too_many_members`. Upgrades: 10 × 101, then 429 `reconnecting too fast`, `Retry-After: 2`. Spoofed-XFF upgrade 429. Honest pair connected. | same | yes (per-key cap, upgrade limiter) |

Honest pair after each case: every play/pause reached both real YouTube players. Run 2 measured both arrivals: 143–642 ms after the click on each side (that includes the tunnel round trip), with a **spread of 0–211 ms** (budget 500). Run 1 measured only B's arrival, 122–600 ms. ngrok's inspector showed 101 × 42, 200 × 81, 401 × 44, 403 × 2 and 429 × 14 over both runs. Evidence: `m3-abuse.json` (run 2), `m3-abuse-run1.json`, `m3-abuse-b0-{a,b}.png`. The tunnel host is withheld.

No FAIL, so no blocker issues.
