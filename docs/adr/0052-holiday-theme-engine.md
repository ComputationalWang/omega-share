# ADR 0052 — Holiday theme engine: client-side dates, overlay layers, a capped effect

**Status:** accepted (2026-10-15) · [OME-1186](/OME/issues/OME-1186), plan on [OME-1140](/OME/issues/OME-1140#document-plan)

## Context

During a holiday the classic room gets a seasonal look: wall and window decor, a small background effect and a hat on every avatar. This must not touch the wire contract, the server or the landing page's budgets. It also must not cost the room frames (`docs/perf-budgets.md`, priority 1).

## Decision

**Resolution: client-only, local date.** `apps/web/src/theme/periods.ts` `activeTheme(date)` reads the viewer's local calendar day. Each period is inclusive at both ends: Halloween Oct 24 – Nov 1, Sinterklaas Nov 14 – Dec 6, Christmas Dec 7 – Dec 31, Valentine's Feb 10 – Feb 14, and Easter from Easter Sunday − 7 days to Easter Monday (Gregorian computus, Meeus/Jones/Butcher). Nothing travels and `packages/shared` is untouched, so a clock that is a day off may see a different theme at a boundary. We accept that. `localStorage["omega.theme"]` set to a theme id forces that theme, `off` disables themes, and any other value is ignored (Valibot picklist).

**"Classic" means the layout equals `DEFAULT_LAYOUT`.** The preset id never reaches the client, and the classic preset is byte-identical to `DEFAULT_LAYOUT`. `sceneOf` sets `Scene.classic` when `layoutKey(layout) === layoutKey(DEFAULT_LAYOUT)`. An owner-edited classic room counts as a different layout and gets no decor. Hats and the effect show in every room.

**Layers** (`room-view.ts`, inside the zoomed stage, so pinch-zoom scales them for free):
- `decor` sits right after the static background (floor and walls), under the seat markers, furniture objects and avatars. Each piece is a sprite at the floor point of its wall frame (`meta.omega.decor[].on`). The decor is rebuilt only when the scene changes or the theme arrives.
- The effect is **not** a Pixi layer. It is drawn on a small overlay canvas (`.scene-fx`) that covers only the effect's band: the two back walls and the window, `BAND` in `theme/atlas.ts`, plus the wrap margin and a sprite's reach on every side (`effectBounds`). That is at most a third of the stage, with 1 backing px per stage px and `image-rendering: pixelated`. The overlay sits over the room canvas and under the DOM layers, inside the zoomed stage, and is put in the DOM only while an effect runs. A tick clears the squares it drew last time and draws the particles again (`createEffectPainter`). It never reads a canvas and never renders the room. Particles pass in front of whatever is in the band.
  - Round 1: the effect was drawn inside the Pixi stage, so each 30 Hz tick re-rendered the whole room. QA ([OME-1206](/OME/issues/OME-1206)) measured phone work p95 at +2.5 to +3.6 ms, over the 8 ms budget.
  - Round 2: a full-size overlay at device resolution. QA ([OME-1211](/OME/issues/OME-1211)) found the layer itself cost about 2.5 ms a frame on a phone, even when nothing was drawn on it. A 1× backing store halved that, and drawing 40 particles was within noise.
  - Round 3: drawing into the room canvas over saved patches. QA ([OME-1212](/OME/issues/OME-1212)) measured about 250 ms a frame: each patch read the room canvas back between draws. So a tick must never read a canvas. `e2e/theme.e2e.ts` now fails if a tick takes 4 ms or more, or if the overlay grows past a third of the stage.
  - Round 4 (this design): QA ([OME-1216](/OME/issues/OME-1216)) found the overlay clean but still +0.8 ms mean on the phone rows, and 5 of 20 runs over 8 ms. In the phone watch layout the room window crops the back walls almost entirely. So the effect runs only while at least half its overlay is on screen: an `IntersectionObserver` with no per-frame cost. The overlay stays in the DOM with `visibility: hidden` while it sleeps, so the observer still sees where it is. On a phone it wakes when the room is zoomed out ("Fit"). The tick-time guard skips the first three ticks (one-off costs).
- Hats: each avatar gets one sprite in the object layer at `zIndex + 0.5`, which is over its own avatar and under the next depth. Its texture is `theme.hat(avatarFrame)`. The theme sheet's hat is the difference between the hatted frame and the shipped one (assets/STYLE.md "Holiday themes"), so drawing it over the frame replaces the avatar's own headwear. A frame with no hat (an emote sticker) hides it. Lookups are cached per frame key, so a walking frame builds no strings.

**Lazy art.** `room-view.ts` imports `theme/atlas.ts` only while a theme is active, and each theme's sheet is its own chunk below that (`theme/halloween.ts`: 7.6 KB gzipped, cap 40 KB). Until the art for the four later themes lands (plan issue E), they draw placeholder coloured rects from `theme/placeholder.ts`. Neither the landing page nor `index.html` preloads any of this.

**Effect perf rules.**
- `theme/effect.ts` keeps positions and velocities in typed arrays allocated once. `step()` writes into the same arrays, and positions are whole pixels.
- The effect runs on its own rAF loop, capped at 30 Hz (`EFFECT_MIN_INTERVAL_MS = 33`). The room itself renders on demand (OME-185).
- An effect tick never renders the room. An idle themed room draws itself only when avatars breathe, as an unthemed room does; `e2e/theme.e2e.ts` asserts this.
- The loop stops while the room is paused (full screen, popped out) and restarts on resume. rAF stops by itself while the tab is hidden.
- No filters and no blend modes.
- The effect is off under `prefers-reduced-motion` and once the walk tier settles on Basic (ADR 0037: reduced motion, Save-Data, weak devices, or a dropped Smooth). While the tier is still probing, the effect runs. Decor and hats stay in every case.

## Consequences

- Adding a theme means one row in `periods.ts`, one motion in `atlas.ts` and one sheet module. The engine itself doesn't change.
- e2e and perf contexts pin `omega.theme` through `e2e/support/csp.ts` `watchCsp`: `off` by default, so the calendar never changes a run, or `OMEGA_THEME=<id>`. A typo is refused. QA runs the phone, desktop, chat-burst and 25-walker perf rows with `OMEGA_THEME=christmas`, the heaviest theme at 40 sprites. A spec that forces a theme in its own init script wins.
- Not done: the optional palette accent (a lamp tint), and turning the effect back on after reduced motion is switched off mid-session (it comes back the next time the room opens).
