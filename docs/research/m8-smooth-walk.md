# M8 research: smooth walk tiers, bubble and wheel rendering, perf cost

OME-645 (M8 plan item R-M8a, plan on OME-643). Researched 2026-10-09. Read-only: no product code changed. Repo facts are `file:line` on `main@08b43bb`. Numbers come from a throwaway prototype (Appendix A) measured with the perf harness's own trace (`perf/frames.ts` `tracedFrames`, ADR 0017 work per frame) in headless Chromium.

Feeds M8 W1 (bubbles), W2 (smooth walk tiers) and W3 (emote wheel).

---

## Summary

- **The seam is small.** Motion is quantised in three places: the step clock (`walks.ts:92`), step time (`walks.ts:94`, used at `:146` and `:215`), and the animator's per-step timer (`animator.ts:137-139`). Smooth needs an unquantised `t` there, whole-pixel rounding, a frame index from the tier, and "request the next rAF while anyone walks" in place of the timer. Paths, arrival times and the shared start clock stay the same.
- **No `packages/shared` change, and no wire change.** Walking is client-local (ADR 0029). The 8-frame cycle changes the *asset* contract (ADR 0010 `meta.omega.walk`, parsed at `motion.ts:18` and `:80-81`). That needs an ADR amendment and a `motion.ts` change, not a contract issue.
- **Smooth costs no more per frame, but about 9× more CPU while anyone walks.** Each render is a full redraw of the 2D canvas, and it costs the same on both tiers. With 25 avatars walking, work p95 matches across tiers on every profile (desktop 1×: 2.1 vs 2.1–2.2 ms; Pixel 7 emulation: 3.8–4.0 vs 4.2 ms). Smooth renders about 330 times in 5 s where Basic renders 36. That is battery and headroom, not jank.
- **The plan's frame-time probe is too loose.** rAF frame p95 read 16.7 ms on every profile, including ones whose main-thread work was 11–19 ms against the 8 ms budget. **Use a post-frame work probe instead**: time from our render to a MessageChannel message after the frame. It tracked the traced work p95 within about 0–2 ms on every profile. The proposed numbers are in §3.
- **Bubbles and the emote wheel stay DOM.** A Pixi bubble that drifts for 5 s would force the room to redraw every frame after every chat line. A phone render costs about 10 ms at 4× CPU, so that would break Basic. A DOM bubble animates `transform`/`opacity` on the compositor at zero room renders. The wheel is a `role="menu"` like today's picker (`emote/picker.ts:28-37`).

---

## 1. Where motion is stepped today, and the seam

### Today

| What | Where | Effect |
|---|---|---|
| Walk speed constants | `apps/web/src/walk/walks.ts:14-16` | `WALK_FRAME_MS = 150`, `WALK_FRAMES = 4`, `TILE_MS = 600` (one cycle per tile). |
| Waypoint times | `walks.ts:128-139` | Each waypoint's time is `(d / TILE_LEN) * TILE_MS`. Continuous, not stepped. |
| Shared start clock | `walks.ts:92` `stepClock`, used at `:141` | Every walk starts on the next 150 ms tick, so all walkers step together. |
| Step time | `walks.ts:94` `stepTime`, used at `:146` (sample) and `:215` (re-route mid-walk) | Walk time is floored to the 150 ms step, so position moves in whole `stepPx` steps (8 × 4 px, ADR 0010). |
| Position | `walks.ts:157-159` | Linear interpolation between waypoints, at the floored `t`. |
| Frame index | `walks.ts:164` | `step = floor(t / 150) % 4`. `Pose.step` is documented as 0..3 (`walks.ts:40`). |
| Redraw schedule | `animator.ts:137-139` | While anyone walks: a timer to the next 150 ms tick, then one rAF (≤ 6.7 renders/s). At rest: the 400 ms breathe clock (`animator.ts:10`, `:140-142`). |
| Frame key | `animator.ts:63` | `frames.walk[avatar][dir][p.step]`. |
| Atlas contract | `motion.ts:18` (`frameMs: v.literal(150)`, `tilesPerCycle: 1`), `motion.ts:80-81` (exactly 4 frames, each 150 ms) | Rejects any other walk timing. |
| DOM followers | `room-view.ts:163-167` calls `onMove` only when x/y changed. `room.ts:403-411` moves the tag, bubble and emote badge (`room.ts:174-176` writes `transform`). | One write per walker per render. |

### Smallest seam (W2)

1. **`WalksOptions.smooth: () => boolean`** (`walks.ts:48-52`), read live so a mid-session drop takes effect on the next sample. When it is true:
   - `sampleEntry` uses `t = max(0, now - e.start)` instead of `stepTime(...)` (`walks.ts:146`), and the re-route at `:215` does the same.
   - Round `out.x`/`out.y` to whole stage px after `:158-159`. Nearest-neighbour art stays crisp, and `onMove` writes fewer.
   - `out.step = floor(t / frameMs) % frames` with the tier's `frameMs`/`frames` (Smooth 75/8, Basic 150/4).
   - **Keep `stepClock` (`:141`) on both tiers.** Start and arrival times then match exactly across tiers, so everything that keys off "arrived" (`walking()`, rest phase, seat badges) behaves the same. Smooth starts up to 150 ms late, which nobody sees.
2. **`AnimatorOptions.smooth: () => boolean`** (`animator.ts:20-32`). In `schedule` (`:130-145`), when smooth and `walks.walking(now)`, call `requestFrame()` instead of setting the step timer. Everything else stays: rAF-only (a hidden tab never renders), `pause()`, `dispose()`, and the breathe and emote timers at rest.
3. **8-frame cycle without doubling the atlas.** The designer delivers `walk/<id>/<dir>` as 8 frames at 75 ms. **Basic plays the even frames (0, 2, 4, 6) at 150 ms.** That puts one acceptance note on D-M8a: the even frames must read as a good 4-frame cycle. `parseMotion` accepts 4 or 8 frames with `ms × frames = 600`. If the sheet still has 4 frames, Smooth plays 4 at 150 ms with smooth position, so engineering never waits on art (CLAUDE.md "never blocks").
4. **The tier itself:** a new pure module `apps/web/src/walk/tier.ts`. It takes the hints (§3) and the probe samples, and returns `"smooth" | "basic"`, latched to Basic once it drops. `room-view.ts:134-138` passes `tier.smooth` to both. Add a `localStorage["omega.motion"] = "smooth" | "basic"` override, read at room start, so e2e and perf can force a tier in the preview build (perf has no dev handle).

**Contract:** nothing in `packages/shared` or on the wire changes. The server stays seat-authoritative, and clients never send positions. The documents that change are:
- a new **ADR 0035 "Tiered walking"**. It amends ADR 0029's "no per-frame loop" (allowed in Smooth while anyone walks) and ADR 0010's `meta.omega.walk` (`frameMs: 75`, 8 frames, `tilesPerCycle: 1`, with `stepPx` now Basic-only).
- `assets/avatars/motion.json`, and the asset build's check of `walk`.

**Tests that change on purpose:**
- `apps/web/test/walk-walks.test.ts:189-200` ("whole steps") and `walk-animator.test.ts:85` ("one redraw per 150 ms step"): keep them as Basic cases, and add Smooth twins.
- `e2e/walk.e2e.ts:73` and `:86`: pin a tier with the override.
- `perf/polish.perf.ts` walk rows: run once per tier (Q1).

## 2. Cost per tier (25 avatars walking)

**Setup.** The prototype (Appendix A) builds the real `createRoomView` on `DEFAULT_LAYOUT` (12 pieces, 33 spots) as a production build (`vite build`/`preview`). It has 25 avatars with the real motion atlas and 25 DOM name tags moved by `onMove` the way `room.ts:174-176` moves them. It re-targets everyone every 2.5 s so all 25 walk the whole time. No video is playing, so the numbers are the room's own cost.
- **Window:** 5 s of `tracedFrames`, 2 reps per row, under `flock` on the perf lock, load average < 2.5.
- **Profiles:**
  - `Desktop Chrome` 1000×700, DPR 1.
  - `Pixel 7` emulation: 412×915, DPR 2.625, so the room renders at resolution 2 (`room-view.ts:96`).
  - CPU slowed with `Emulation.setCPUThrottlingRate`. As rough stand-ins, 4–6× is a low-end laptop and 2–4× a mid phone (Lighthouse's mobile preset uses 4×).

Work = ADR 0017 main-thread work per frame, p95 (budget ≤ 8 ms). Frame = rAF delta p95 (budget ≤ 16.7 ms). Renders = room renders in the 5 s window.

| Profile | Tier | Frame p95 | Missed vsync | Work p50 | **Work p95** | Renders / 5 s | Room CPU per s of walking |
|---|---|---|---|---|---|---|---|
| Desktop 1× | Basic | 16.7 | 0 % | 0.1 | **2.1** | 36 | ≈ 14 ms |
| Desktop 1× | Smooth | 16.7–16.8 | 0 % | 1.8 | **2.1–2.2** | ≈ 328 | ≈ 118 ms |
| Desktop 4× | Basic | 16.7–16.8 | 0 % | 0.1 | **5.5–5.9** | 36 | ≈ 41 ms |
| Desktop 4× | Smooth | 16.7 | 0 % | 4.4–4.5 | **5.2–5.8** | ≈ 328 | ≈ 290 ms |
| Desktop 6× | Basic | 16.7–16.8 | 0 % | 0.04 | **8.1–8.3** | 36 | ≈ 59 ms |
| Desktop 6× | Smooth | 16.7–16.8 | 0 % | 6.4–6.6 | **7.6–9.2** | ≈ 328 | ≈ 425 ms |
| Phone 1× | Basic | 16.7 | 0 % | 0.1 | **3.8–4.0** | 36 | ≈ 29 ms |
| Phone 1× | Smooth | 16.7–16.8 | 0 % | 3.7 | **4.2** | ≈ 328 | ≈ 245 ms |
| Phone 2× | Basic | 16.7–16.8 | 0 % | 0.1 | **5.6–8.2** | 36 | ≈ 55 ms |
| Phone 2× | Smooth | 16.7–16.8 | 0 % | 5.0–5.9 | **6.4–7.3** | ≈ 327 | ≈ 360 ms |
| Phone 4× | Basic | 16.7–16.8 | 0 % | 0.1 | **10.3–11.1** | 36 | ≈ 77 ms |
| Phone 4× | Smooth | 16.7 | 0 % | 10.1–10.2 | **11.2–11.3** | ≈ 331 | ≈ 670 ms |
| Phone 6× | Basic | 16.7 | 0–0.3 % | 0.05 | **15.7–15.8** | 36 | ≈ 115 ms |
| Phone 6× | Smooth | 16.8 | 1.0–2.4 % | 16.0–16.2 | **19.1** | ≈ 324 | ≈ 1,040 ms |

(For 8 walkers at desktop 1×, work p95 is 1.8 ms on Basic and 1.7–2.0 ms on Smooth.)

What this says:
- **The cost of a render is the same on both tiers.** It is a full redraw of the 2D canvas (ADR 0029), and it grows with canvas pixels: a phone at DPR 2 costs about twice as much as desktop at 1×. Basic's p95 lands on its step renders, because about 11 % of frames are renders. That is why p95 barely differs between tiers.
- **What Smooth costs is the duty cycle.** About 9× more room CPU per second while anyone walks. On a mid phone (4×) that is about two thirds of a core for as long as people move, which means battery and heat, and less headroom for the player and chat. This is the real argument for the tier.
- **On the budget profiles, Smooth fits easily.** Desktop 1× uses 2.2 ms of the 8 ms budget. The `Pixel 7` emulation (OME-596 profile, no CPU throttling) uses 4.2 ms, with 25 walkers where the budget's phone row has 8. On slowed profiles, Basic already goes over 8 ms p95 at phone 4× and desktop 6×, so the probe has to keep Smooth off there (§3).
- **Draw calls.** On the 2D canvas renderer there is no batching: each display object is one `drawImage` or path fill. The count per render is the same on both tiers: the floor `Graphics` (100 diamonds, `room-view.ts:106-108`), the furniture sprites, 25 avatar sprites, and any stickers. Smooth multiplies renders per second (≤ 60 while walking, against ≤ 6.7), not draw calls per render.
- **Caching the floor doesn't help.** Prerendering the floor into one full-stage sprite made phone 4× Smooth *worse*: work p95 went from 11.4–11.6 to 14.5–15.2 ms. A full-screen `drawImage` at resolution 2 costs more than 100 small fills. Don't do it.
- **DOM followers cost nothing measurable in CPU. They do create garbage.** Turning the 25 tags off left work unchanged (phone 4× Smooth: 13.4–16.4 ms without tags, 11.4–11.6 with, within noise). They do account for the heap churn: Smooth grows the heap by about 1.3 MB per 5 s, against 0.35 on Basic. Without tags it is −0.15, because the `translate(...)` strings are one allocation per walker per frame. Minor GC collects it (heap stays ≈ 6 MB, against the 150 MB budget), so this doesn't block anything. Cheap fixes for W2: skip the write when the rounded px is unchanged (already done for x/y at `room-view.ts:163`), or split x and y over two nested elements with a precomputed `translateX(Npx)` / `translateY(Npx)` string table (961 + 601 strings, built once).
- **Atlas memory.** `motion.png` is 1024×512, with 175 frames using 331,520 px (63 %). An 8-frame walk adds 64 frames of 32×64 = 131,072 px, which makes 88 %. **It fits in the same 1024×512 sheet** (2 MiB decoded RGBA, no change). If the packer can't fit it, the next size is 1024×1024 (+2 MiB decoded GPU/bitmap memory, not JS heap). On disk: `motion.png` grows from 14.6 KB by about +6 KB, and `motion.json` grows by about +32 KB raw (about +3 KB gzip, at ≈ 500 B per frame). Both are in the lazy `motion-atlas` chunk (70.8 KB raw / 5.4 KB gzip today), so **initial JS is unchanged**.

## 3. The tier rule: check and proposal

| Plan clause | Verdict | Why |
|---|---|---|
| `prefers-reduced-motion` → not Smooth | **Keep** | It already means "no walk at all": snap to the spot and hold the still pose (`walks.ts:186`, ADR 0029). It overrides both tiers. |
| Save-Data → Basic | **Keep** | Cheap. Chromium only (`navigator.connection.saveData`). Absent counts as off. |
| `hardwareConcurrency ≥ 4` | **Keep, but it only gates laptops** | It drops 2-thread Celerons (N4020/N4500), which is right. Every current mid phone reports 8, so on phones it does nothing. |
| `deviceMemory ≥ 4` "where reported" | **Keep** | Chromium reports a power of two capped at 8, which drops 2–3 GB phones. Firefox doesn't report it, so absent counts as passing, as the plan says. |
| rAF frame p95 ≤ 18 ms over the first 120 frames | **Too loose. Replace it.** | Frame p95 was 16.7 ms on *every* profile, including phone 4× (work 11 ms) and phone 6× (work 16–19 ms). The frame clock only moves after the work is already twice the budget. It is also blind in an idle room: 120 rAF frames at rest contain at most a handful of renders (breathe clock, ≤ 2.5/s), so it measures the device, not our cost. |
| Drop at p95 > 22 ms over any 5 s | **Too loose, with no real hysteresis** | rAF deltas come in whole vsyncs. At 60 Hz, "≤ 18" and "> 22" both just mean "more than 5 % of frames late", so the 18/22 gap isn't hysteresis. At 90 Hz a single missed vsync (22.2 ms) already counts as "> 22". It also counts jank that isn't ours: on Android a cross-site player iframe can share our main thread [unverified: depends on Android's site-isolation mode]. |

**Proposed rule (W2):**
1. **Static gates** as in the plan. Reduced motion → no walk. Save-Data, `hardwareConcurrency < 4`, or a reported `deviceMemory < 4` → Basic for the session.
2. **Start in Basic.** Basic step and breathe renders are the same full redraw a Smooth frame does (§2), so the probe needs no extra rendering.
3. **Probe = post-render work.** In the animator's `tick`, after `o.render()`, post on a `MessageChannel` made once. The handler records `performance.now() - tickStart`. That message runs after the frame's paint and commit, so it captures the canvas raster cost that the JS alone never shows: our JS was only 10–25 % of the traced work. Store samples in a preallocated ring (`Float64Array(120)`), with no allocation per frame. Measured against the trace:

   | Profile (Smooth, 25 walking) | Traced work p95 | Post-render p95 | JS-only (`drawAll` + `render`) p95 |
   |---|---|---|---|
   | Desktop 1× | 2.1–2.2 | 2.0–2.1 | 0.5–0.6 |
   | Desktop 4× | 5.2–5.8 | 5.5–6.0 | 1.3–1.5 |
   | Desktop 6× | 7.6–9.2 | 7.5–9.3 | 1.8–2.3 |
   | Phone 1× | 4.1 | 4.1 | 0.6 |
   | Phone 2× | 6.1 | 6.3 | 1.0 |
   | Phone 4× | 13.4 | 13.4 | 1.8 |
   | Phone 6× | 17.4 | 17.4 | 2.6 |

   (The phone rows and the 1×/4×/6× desktop rows come from separate runs. The phone run was under some host load, so its absolute work is higher than in the §2 table. The post-render column tracks the work column within each run, which is the point.)
4. **Upgrade to Smooth when** both hold over the **first 30 room renders** (≈ 4.5 s of walking, or ≈ 12 s at rest):
   - post-render **p95 ≤ 8 ms** (the work budget itself; a Smooth frame costs what that render cost);
   - the median rAF interval over the same span is ≤ 20 ms. Chrome's battery saver caps rAF at 30 Hz [unverified for current Android builds], and Smooth at 30 Hz isn't worth its cost.

   Measured Basic post-render p95: desktop 1× 2.6 ✓, desktop 4× 7.4 ✓, desktop 6× 9.7–10.3 ✗, phone 1× 5.3 ✓, phone 2× 8.4 (borderline; Smooth there measured 6.4–7.3 ms of work), phone 4× 12.4 ✗. That keeps Smooth wherever a Smooth frame stays inside 8 ms.
5. **Drop to Basic for the session when either holds:**
   - post-render p95 > **10 ms** over the last **120 Smooth walking renders** (≈ 2 s of walking). 8 up / 10 down is real hysteresis on a continuous measure.
   - more than **5 % of rAF deltas** over 5 s of *walking* frames are late, where late means more than 1.5× the median interval. That holds at any refresh rate.

   Count only frames in which Smooth drew a walk. Ignore any delta over 1 s (a tab coming back, or a pause for full screen). No flipping back until reload, as planned.
6. **Overrides.** `localStorage["omega.motion"]` (§1) forces a tier for e2e and perf, and later for a user setting. Q1 runs `polish.perf.ts`, the phone run and the 25-person load test on both forced tiers.

## 4. Chat bubbles (item 1) and the emote wheel (item 3): DOM, not Pixi

**Bubbles: keep the DOM overlay that exists today** (`.bubbles` layer at `room.ts:268`, one `<p>` per member at `room.ts:953-968`, following the avatar through `onMove` at `room.ts:403-411`).
- **Perf.** The room renders on demand (ADR 0029). If a bubble drifted and faded on the canvas, every chat line would hold the room at 60 renders/s for 5 s. A full burst (perf-budgets.md:12-14: 7 members, 5 each, then 1/s) keeps it rendering every frame for good, which would cancel Basic outright (phone 4× pays ≈ 10 ms per render, §2). Text on the 2D canvas renderer also means `measureText` plus a fresh canvas texture per message. A DOM bubble animated only through `transform` and `opacity` runs on the compositor with **zero room renders and zero JS per frame**.
- **How (W1):**
  - Two nested elements per bubble. The outer one takes the avatar position from `onMove` (as today). The inner one runs the drift and fade `@keyframes`, so a walk never restarts the animation.
  - A fixed pool of 8 nodes, reused oldest-first. No create/destroy per message, and the "at most 8" rule comes for free.
  - Overlap is resolved once per new bubble (and once when a walk ends), against the live bubbles' rects (`layout.ts:191` `bubbleRect`), never per frame.
  - `contain: layout paint` on the layer.
  - `@media (prefers-reduced-motion: reduce)` drops the drift and keeps the fade.
- **a11y.** Make the layer `aria-hidden="true"` and remove `ariaLive: "polite"` from it (`room.ts:268`). Today both it and the chat log (`chat/log.ts:62-63`, `role="log" aria-live="polite"`) are live regions, so a screen reader may read every message twice. The log stays the accessible source, as the plan says. The emote badges that share this layer (`room.ts:396`) are already `aria-hidden` (`emote/badges.ts:33`).

**Emote wheel: DOM, reusing the picker's model** (`emote/picker.ts:28-37`: a trigger with `aria-haspopup="menu"` and `aria-expanded`, `role="menu"` with `aria-label="Emotes"`, `role="menuitem"` buttons with `aria-label` and `aria-keyshortcuts`, and `aria-disabled` while out of tokens at `:58-59`).
- **Why not Pixi.** It would need a parallel hidden DOM menu for screen readers anyway, plus pointer hit-testing. Every hover or open animation would force room renders.
- **How (W3):**
  - The six items (`EmoteKind`) are laid out on a circle with `transform`s computed once when the wheel is built.
  - It opens at `view.position(self)` lifted by `EMOTE_LIFT` (`animator.ts:13`), and closes if your own avatar starts walking.
  - Roving `tabindex`: ←/→ (and ↑/↓) move clockwise and anticlockwise, Enter or click sends, Esc or T closes, and focus goes back to where it was.
  - T is ignored while a text field, a `<dialog>` (the report dialog, OME-601), IME composition (`e.isComposing`) or a modifier key is active.
  - The open/close scale and fade is a CSS transition, skipped under reduced motion.
  - The DOM is built on first open. It is small, so there's no need for a separate chunk.
  - Touch: the emote key by the chat input opens the same menu.
- **Perf.** No canvas draws. Opening it costs one style and layout pass for 6 buttons, well under the 50 ms long-task limit.

---

## Appendix A: prototype (throwaway, not merged)

Built in a scratch worktree off `main@08b43bb`, with a global `SMOOTH.on` flag:
- In `walks.ts`, with Smooth on: `stepClock` returns `now`, `stepTime` returns `t`, x/y are rounded, and `step = floor(t / 75) % 4` (4-frame art swapped at the 75 ms rate, which costs the same as 8 frames).
- In `animator.ts`, `schedule` calls `requestFrame()` while anyone walks.

A `proto.html` page builds `createRoomView` on `DEFAULT_LAYOUT` with 25 avatars and 25 DOM tags, and re-targets everyone every 2.5 s. A bench script runs `tracedFrames` over each case. The probe columns come from timing `drawAll` plus `render` in `tick`, and from a `MessageChannel` posted after `render`. Note that the prototype starts Smooth walks on `now`, while §1 recommends keeping the shared clock. That moves start times by ≤ 150 ms and doesn't change the cost.
