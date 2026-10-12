# ADR 0044 — Phone portrait room and dock

**Status:** accepted, 2026-10-11; OME-909. Runtime acceptance and phone performance remain PR review gates.

## Context

The approved M10 portrait design keeps the video, room, last chat line and composer visible on a phone without scrolling the document. The previous fixed room crop plus separate queue and chat panels exceeded the viewport. The on-screen keyboard changes the visual viewport independently of the layout viewport.

## Decision

Enable the dock only in portrait at the existing phone breakpoint, outside full screen. Allocate the remaining viewport height to the room crop rather than enforcing its previous fixed height. Preserve the room's native scale and camera; desktop, landscape and the full-screen layout retain their existing rules.

Reuse the existing composer, live chat log and queue panel. Expose queue/link sharing, the full chat log and host settings through sheets. Moving these existing nodes preserves message history, drafts, queue validation, permissions and the single client WebSocket. Use modal dialog focus containment, Escape dismissal and focus return to the opening key.

Size the portrait surface from visualViewport resize/scroll events when available, with the layout viewport as fallback. During keyboard entry, the room gives space to the scrollable log or queue and the field remains docked to the visible viewport. Restore the camera and node placement when entry or portrait mode ends. Layout updates remain event driven; introduce no animation-loop work or dependencies.

Reserve the queue sheet's paste/Add row independently of keyboard detection. Queue headings, items, empty artwork and validation or permission messages share an internally scrolling body above the fixed row, so Android resizing both layout and visual viewports cannot push the field beyond the dialog. Keep these messages reachable instead of hiding them based on inferred typing state. Outside portrait, retain the existing queue presentation.

When keyboard entry hides the portrait picture's playback controls, expose its internally scrolling surface as a named keyboard stop. Restore its previous attributes when entry or portrait mode ends.

Keep People in the existing document flow, but bound its portrait surface to 35% of the dock height and let it shrink and scroll internally. Give its rows and hide/show buttons physical 44px targets. When People remains open during keyboard entry, retain its room-bar toggle and reserve at least 64px for a wrapped latest chat preview; the picture region gives up visible height and retains its existing internal scrolling. This supports the 25-member room budget without clipping the composer or changing People semantics. Desktop and landscape keep their existing People layout.

## Consequences

Portrait room height varies with browser chrome and the keyboard. History and queue content scroll within their own surfaces. Provider player minimum sizes remain authoritative, including Twitch's larger picture. The picture and shelf region scrolls internally when a provider exceeds the phone width or the available keyboard height. This keeps the field reachable without shrinking the embed or scrolling the document; a very short viewport may show only part of the picture at once. Changing provider minima requires a separate decision. CI owns deterministic browser geometry, queue, keyboard and axe coverage at 360×740 and 390×844. QA owns actual provider acceptance and the phone performance budget before merge.
