# ADR 0062: Portrait Twitch letterboxes; failed lazy chunks offer Reload

**Status:** accepted (2026-11-04) · Council review

**Context:** QA [OME-1870](/OME/issues/OME-1870) asserted a 534×300 minimum for Twitch on phones, the width needed to keep a 300 px picture at 16:9. This PR's council review found clipped player controls on 412 px phones. Twitch's embed rule is at least 400×300; it does not require 16:9.

The council e2e traces also showed that Chromium retains a failed module import in its module map. Retrying that import on the same page rejects again without a network request.

## Decision

Twitch uses a 400×300 floor in the phone room layout and in full screen when the viewport is narrower than it is tall, including hidden chat. The player takes the available width above 400 px and letterboxes while its 16:9 height would be under 300 px. Landscape full screen and desktop room layouts keep the 534×300 floor. This amends ADR 0012's portrait sizing.

When the room or directory chunk fails to import, `apps/web/src/main.ts` offers Reload, which reloads the page and gives the import a fresh module map. A `startRoom` failure after a successful import keeps “Try again”: opening the room can be retried without importing a failed chunk.

## Consequences

A 412 px portrait phone gets a 412×300 Twitch player; horizontal overflow remains below 400 px. Failed chunk recovery restarts the page, while room startup recovery stays on the page.
