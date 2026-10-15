# ADR 0052 — Holiday theme engine: client-side dates, overlay layers, a capped effect

**Status:** accepted (2026-10-15) · [OME-1186](/OME/issues/OME-1186), plan on [OME-1140](/OME/issues/OME-1140#document-plan)

## Context

During a holiday the classic room gets a seasonal look: wall and window decor, a small background effect and a hat on every avatar. This must not touch the wire contract, the server or the landing page's budgets. It also must not cost the room frames (`docs/perf-budgets.md`, priority 1).

## Decision

**Resolution: client-only, local date.** `apps/web/src/theme/periods.ts` `activeTheme(date)` reads the viewer's local calendar day. Each period is inclusive at both ends: Halloween Oct 24 – Nov 1, Sinterklaas Nov 14 – Dec 6, Christmas Dec 7 – Dec 31, Valentine's Feb 10 – Feb 14, and Easter from Easter Sunday − 7 days to Easter Monday (Gregorian computus, Meeus/Jones/Butcher). Nothing travels and `packages/shared` is untouched, so a clock that is a day off may see a different theme at a boundary. We accept that. `localStorage["omega.theme"]` set to a theme id forces that theme, `off` disables themes, and any other value is ignored (Valibot picklist).

**"Classic" means the layout equals `DEFAULT_LAYOUT`.** The preset id never reaches the client, and the classic preset is byte-identical to `DEFAULT_LAYOUT`. `sceneOf` sets `Scene.classic` when `layoutKey(layout) === layoutKey(DEFAULT_LAYOUT)`. An owner-edited classic room counts as a different layout and gets no decor. Hats and the effect show in every room.

**Layers** (`room-view.ts`, inside the zoomed stage, so pinch-zoom scales them for free):
- `decor` sits right after the static background (floor and walls), under the seat markers, furniture objects and avatars. Each piece is a sprite at the floor point of its wall frame (`meta.omega.decor[].on`). The decor is rebuilt only when the scene changes or the theme arrives.
- The effect is **not** a Pixi layer and has **no canvas of its own**. `createEffectPainter` draws the ≤ 40 particles straight into the room canvas (Pixi's own 2D context), in front of the avatars. Before drawing a particle, it copies the square of room pixels under it into that particle's slot on a small off-DOM patch canvas, clearing the slot first. The next tick clears each square and puts it back, last first, then draws again. Before each Pixi render, the room view puts every square back too. Pixi's 2D `clear()` runs under whatever transform was last set, so it doesn't reliably wipe the transparent margins; putting the squares back first keeps leftover particles from surviving a render.
  - Why, round 1: the first version drew the effect inside the Pixi stage, so each 30 Hz tick re-rendered the whole room. QA ([OME-1206](/OME/issues/OME-1206)) measured phone work p95 at +2.5 to +3.6 ms, over the 8 ms budget.
  - Why, round 2: an overlay canvas over the room fixed the re-render, but QA ([OME-1211](/OME/issues/OME-1211)) showed that an extra full-size layer costs a phone about 2.5 ms a frame even when nothing is drawn on it. Drawing 40 particles into a canvas is within noise of `off`.
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
