# M10: starting rooms and portrait phones — set (n)

Six starting rooms reuse the Dusk Lounge palette, 2:1 grid and existing furniture atlas. No new furniture kinds or atlas frames are required. These are original arrangements of our original CC BY-SA 4.0 art; see `assets/LICENSE`. The existing three direction boards in `assets/src/moodboards/` remain the style reference. Dusk Lounge stays selected.

## Starting rooms

`assets/presets/presets.json` is a versioned catalogue: stable ID, name, one-line blurb, relative layout path and thumbnail path. Default is `classic`. Each layout is a plain strict `RoomLayoutInputSchema` object, with one TV, eight seat cells and at most 32 pieces. Every seat faces the TV corner. `empty` keeps the mandatory eight beanbags: it means no optional furnishings. IDs are proposals for the Lead's M10 contract; the designer changes no shared/app code.

| ID | Name | Character |
| --- | --- | --- |
| classic | Classic | Familiar armchairs on the large blue rug |
| cinema | Cinema | Velvet sofa rows, wall art, popcorn |
| living | Living room | Cream couches, reading chairs, books |
| lounge | Lounge | Beanbags, kilims, plants and olive couch |
| cafe | Café | Four paired tables and a snack cart |
| empty | Empty | Bare boards and eight beanbags |

Thumbnails are standalone indexed PNGs, 212×176 native pixels, rendered afresh at 20×10 tile scale. Use native or integer enlargement with nearest-neighbor sampling. They are previews, not new Pixi sprites; room rendering continues to use `room.json` and `furniture.json` as documented in `assets/README.md`. Keep the chosen card visibly ringed and expose its name, description and selected state to assistive technology. Phone cards scroll horizontally; desktop shows a 3×2 grid.

## Portrait layout

`assets/preview/m10.html` is a reference mock, not app code. Both 360×740 and 390×844 show watching, message keyboard, chat sheet, queue sheet, link keyboard, emotes, host settings and moderation. PNGs are in `assets/preview/ui-m10-{360,390}@{1,2}x.png`.

The active browser viewport is one flex column: top bar, 16:9 video, compact transport shelf, remaining-height room, docked composer and safe-area inset. The room absorbs browser chrome and short viewport losses; do not force page scrolling to preserve a minimum room height. OS chrome in the mock is illustrative (22px status + 14px home). At 390×844 the video is 219.4px; at 360×740 it is 202.5px. Use measured viewport dimensions rather than hardcoded diagram heights.

Last chat lines sit over a scrim; an explicit Chat button opens the full scrolling log. The Up next button opens the queue without focusing the field. The composer share button opens it with the paste field focused. Sheets cover the room, leaving the video visible. Actual touch targets, including emotes and host choices, are at least 44×44px. Queue rows keep that height when the keyboard opens; the list scrolls above the fixed paste row.

When typing, hide room/top bar/shelf, keep the video, scroll the chat log above the composer and attach the composer to the keyboard's visible viewport. Link entry does the same with a scrolling queue above its paste row. Blur restores the prior room camera. Opening emotes while typing dismisses the keyboard before opening the tray; closing restores composer focus only on explicit typing intent.

Host settings expose Everyone / Only me, Play next now, Copy invite and the existing desktop arrangement affordance. Moderation is a bottom action sheet from a participant tag; Remove opens the existing confirmation with Cancel focused. Do not remove a guest on the first tap. Only authorized users get queue removal and host controls; the mock queue illustrates an authorized contributor.

Retain existing queue behavior: empty queue explains how to paste a link; blank/invalid links disable Add; pending Add shows progress and rejects duplicates; errors keep the entered URL with inline text and a retry action. These reuse established queue chrome; this set does not change provider support. Sheets trap focus, Escape/Close dismiss, and focus returns to the opener. Reduced motion uses immediate sheet transitions.

## Verification and self-check

- `bun test assets/src/presets.test.ts`: 8 passing tests, all six strict layouts and the thumbnail cap.
- `bunx tsc -p assets --noEmit` and targeted ESLint pass.
- `bun assets/src/shoot-m10.ts`: deterministic indexed art build and headless mock screenshots at 1×/2×.
- Thumbnails: 20,478 bytes total / 40,960 cap. Preset PNGs + gzipped JSON: 22,242 bytes. Combined shipped art budget now includes preset files: 155,799 / 307,200 bytes.
- Researcher reviewed local references; fixes enlarge emotes/host choices, prevent overlapping queue hits, and show list scrolling. No third-party artwork was used.

Rubric self-check (provisional; CEO's independent judge decides): readability 4, distinctness 4, originality 5, consistency 4, isometric correctness 5, technical fitness 4, budget 5, charm 4 = 35/40. Full-size occupied presets and thumbnail sheet were visually inspected. Avatars and atlas anchors are reused unchanged, so distinctness and anchor scores apply to the existing approved set. Engineering must wait for CEO judging before using this set.
