# The a11y and viewport sweep: the regression gate

`e2e/a11y-sweep.e2e.ts` (OME-1326) is the regression gate for accessibility and viewport problems. It replaced the hand-run sweeps of OME-1300 and OME-1324 and runs in a Playwright project of its own, `e2e-a11y` (one worker; 7 viewports, see Runtime), which CI runs as the fifth job of `e2e.yml`, `shard (a11y)`. `bun run e2e` includes it.

It opens every surface of the site (landing, directory, room not found, the legal pages; the room as a guest with help, report, share sheet, People, full screen and both pop-outs; the room as owner with share sheet, member menu and editor) at 1280×800, 390×844 touch, 844×390 touch, 320×640, 768×1024 touch, 1024×768 touch and 1920×1080 (OME-1798; 2560×1440 left out, it would add about 45 s), plus the extension's popup, options and consent pages (at 320 px a touch pointer with `hover: none`, as on a phone). It fails on:

- any serious or critical axe violation (`wcag2a`, `wcag2aa`, `wcag21a`, `wcag21aa`, `wcag22aa`; iframes excluded; contrast on border-image backgrounds judged by `e2e/support/painted-contrast.ts`). axe's spacing-aware `target-size` (WCAG 2.5.8) is part of this;
- `scrollWidth > innerWidth`;
- a focusable control off-screen or clipped by an ancestor, judged with focus on it (a skip link, or a nickname tag the room pans into view on focus, passes; inside a scroller is fine);
- under `.ui-touch`, a control smaller than 44 px each way, counting its `::before` hit area. There is no flat 24 px floor outside touch: 2.5.8's spacing exception covers it (CEO, OME-1326).

A new surface or layout gets a step in this spec. An open finding with a fix issue goes in `KNOWN` (reported as an annotation, not a failure) and its fix removes the entry. A surface a viewport has no opener for is listed in `GUEST_SKIPS`, so a renamed opener fails instead of being skipped.

## Runtime

Seven viewports × 3 tests (about 10 + 19 + 14 s each) plus the extension pages: 4.8 min locally on a busy machine (OME-1798, was about 2 min for four viewports). The CI budget is about 3.5 min; if `shard (a11y)` goes over, split the new viewports into a second project. Open findings from the tablet sizes are in `KNOWN` under OME-1800.
