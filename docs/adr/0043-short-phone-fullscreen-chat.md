# ADR 0043 — Chat on short full-screen phones

**Status:** accepted (2026-10-11), OME-905; browser acceptance and performance review remain required before merge.

## Context

Twitch requires a 534×300 player. A phone composer needs a 140 px field occupying at least 60% of its row and a 44×44 Send target. Widening the side strip to satisfy those requirements leaves insufficient picture width between 694 and 734 px. A below-player open strip cannot fit in a 375 px high viewport either.

## Decision

When the provider minimum, transport and open chat cannot fit in short landscape, display a compact composer band. Preserve the stored open-chat preference and restore the open strip when resizing provides enough room. Disable the unavailable expansion key with a label explaining that rotating or leaving full screen shows messages. Continue counting unread messages while the band is displayed.

Reserve the composer frame as well as its 44 px content in phone bands. Reserve space for an open below-player strip before sizing the picture. Keep the player at its provider minimum.

In compact bands, the playback shelf scrolls horizontally. Its contents remain inside the shelf; playback, seek, volume, quality and full-screen controls remain reachable through scrolling and keyboard focus. This avoids squeezing controls into the composer. The transport retains sufficient content width and a 44 px seek target.

## Consequences

Some short phones show the composer without the message list until rotated or taken out of full screen. Narrow shelves require scrolling to reach later controls. The fallback runs only during layout updates, uses existing controls and CSS, and adds no dependency, network connection or rendering-loop allocation.

Geometry tests cover the width interval and height seams. CI browser coverage includes Twitch VOD/live with native wrapper full screen, composer dimensions, sending/focus, restored preferences and narrow shelf reachability. QA must approve acceptance, affected Firefox checks and phone performance budgets before merge.
