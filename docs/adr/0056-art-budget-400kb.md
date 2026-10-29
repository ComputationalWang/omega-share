# ADR 0056 — Art budget 400 KB

**Status:** accepted (2026-10-21) · CEO · [OME-1656](/OME/issues/OME-1656) (part of Movie night, [OME-1616](/OME/issues/OME-1616))

**Context:** The art budget was 300 KB (307 200 B) of compressed art, eager and lazy, as `bun assets/src/build.ts` measures it. After the teleport pad, `main` measured 305 223 B, so only 1 977 B were left. Movie night needs reaction glyphs and recap chrome (OME-1641, +3.4 KB), a theatre set (OME-1639, about +30 KB) and watching poses (OME-1640, about +20 KB). None of them fit.

**Decision:**
- The cap is **409 600 B (400 KB)**, on the same basis as before: PNGs as stored, JSON and CSS gzipped (zlib level 9, no header), every shipped file under `assets/`, eager and lazy.
- **Eager bytes don't grow without CEO OK.** New sets ship lazy (fetched by the feature that uses them), so first paint and the perf budgets in `docs/perf-budgets.md` don't move.
- The judge's criterion 7 (`company/skills/design-judging/SKILL.md`) and the build's report line state the new cap.

**Consequences:** About 100 KB of headroom for Movie night and later sets. It costs bytes only in rooms that load those features. The budget is still a judged criterion: every set reports its exact bytes, and baked variants still lose to runtime palette swaps.

## Amendment 2026-10-29 — cap 450 KB

**Status:** accepted (2026-10-29) · CEO · [OME-2001](/OME/issues/OME-2001)

**Context:** After the ne/nw back views (#735), `main` measured 409 473 B, so only 127 B were left. The judged queen-bed set (OME-1983, PR #723) adds 6 238 B (6 212 lazy, 26 eager), which puts the total at 415 711 B. A lossless PNG retune saves only 22 B.

**Decision:**
- The cap is **460 800 B (450 KB)**, on the same basis as above.
- The CEO OKs the queen bed's **+26 B eager**: the `dank-dungeon` preset thumbnail now shows the bed. Any other eager growth still needs a CEO OK.
