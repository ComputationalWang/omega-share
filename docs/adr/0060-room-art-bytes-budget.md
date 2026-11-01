# ADR 0060: Room art has a byte budget per preset, ≤ 450 KB gzipped

**Status:** accepted (2026-11-01) · Lead · [OME-2151](/OME/issues/OME-2151) (design judge round 2 on [OME-2122](/OME/issues/OME-2122), QA evidence [OME-2146](/OME/issues/OME-2146#document-review) § 6)

**Context:** The only byte rows in `docs/perf-budgets.md` were the initial JS (≤ 200 KB) and the landing transfer before interaction (≤ 120 KB, room chunks excluded). The art a room pulls in (furniture sheets, avatar and motion sheets, accessories, preset thumbs, site art) had no row, so it could grow unchecked. QA measured it on the dev server, png and json bodies gzipped at level 6: 196 KB for classic, 402 KB for studio, and 425 KB for the union of all 79 art files across the presets. The biggest single files are furniture sheets of 20–27 KB.

## Decision

1. **One row, per preset, the dearest one wins:** "Room art transfer per preset (gzipped)", ≤ 450 KB. It covers every image and JSON art response that a cold context fetches from `/` through the directory into a seated room, on the preview build, with each body gzipped at zlib level 6 (the landing row's method). Scripts and stylesheets stay under their own rows.
2. **The threshold sits just above today's union (425 KB), not at today's dearest preset (402 KB).** Even a room that loaded every art file we ship would pass. About one furniture sheet of headroom is left, so the second new sheet in a preset, or a sheet that doubles, has to win its bytes back first. This is a judgement call: it gates growth without failing on the dev-to-preview difference (minified JSON, real encodings) on day one.
3. **The row is pending until a spec measures it.** `perf/budgets.ts` carries it as `site.artGzip`, and the report shows it as pending (not measured) until the spec lands.

## Consequences

- A new preset or sprite sheet that pushes the dearest preset past 450 KB blocks its merge. The ways out are to share sheets across presets, crop, or palette-quantise, or else to bring a new ADR to raise the threshold.
- Presets are 2× apart today (classic 196 KB, studio 402 KB). The row gates only the dearest one, so a cheap preset can grow up to the cap unnoticed. A per-preset cap would be tighter, but it would need one threshold per preset to maintain. Revisit that if the spread starts to matter.
