# Website redesign: Dusk doorstep — submission round 1

Design delivery for OME-933; implementation belongs to Lead after independent CEO judging. These HTML files are static review drawings, not application code. Open them directly, or inspect the supplied PNGs. They embed images for portable review; engineering must use external PNG URLs, never these embedded payloads.

## Inspectable submission

- `directions-1280.png`: three directions, A Honey daylight, B Dusk doorstep (chosen), C Velvet poster. B carries the original Dusk Lounge room palette into compact site chrome.
- `entry-{1280,1920,360,412}.png`: complete entry screens including extension status and footer.
- `directory-{1280,1920,360,412}.png`: returning-user directory with creation, saved-room and public-room actions; illustrative data, not a live occupancy claim.
- `states-{1280,360}.png`: focus, invalid nickname, loading, empty, fetch failure, and creation submission/failure.
- `before-entry-1280.png`, `before-directory-{1280,360}.png`: production inspection, 2026-10-11, deployed version 979e608. The directory captures follow saved nickname entry and a return to `/`. Current `/` shows entry and directory together; Enter goes to lobby, not to a separate directory screen.
- `before-room-1280.png`: actual deployed lobby inspected after nickname entry. Its shipped room currently displays placeholder floor/seat geometry; the original room and furniture artwork was separately inspected in `assets/preview/furniture-room@1x.png` and `assets/preview/room@1x.png`. The proposed static image uses that existing original furnished-room render.
- `HANDOFF.md`: exact component, state, accessibility and transfer requirements.
- `inventory.json`: measured bytes and dimensions, with the accounting basis.

Before: 10vh welcome margin, narrow 360px directory, geometric avatar buttons, widely separated footer. After: 1104px maximum wrapper, 360px entry form and native room artwork; 328px creation column plus wider room list; actual named avatar sprites; footer in content flow. At 1920px the same readable maximum width is centered. Desktop entry render is 916px high; production initial page was 1266px high at 1280 width, despite its very narrow directory. Phone screens scroll naturally and keep controls at least 44px tall. No decorative animation or redundant panels.

The derivative `assets/site/website-room.png` is a lossless crop (656×536 at +152,+0) of the existing 960×600 furniture room preview. Reproduce with ImageMagick: `magick assets/preview/furniture-room@1x.png -crop 656x536+152+0 +repage PNG8:assets/site/website-room.png`. It keeps original pixel density and the 2:1 room geometry. Original work, credit/license unchanged: `assets/LICENSE`, CC BY-SA 4.0. Existing art remains the source; no third-party reference artwork was imported.

Researcher subagent inspected production HTTP/footer destinations, current entry-to-lobby behavior, home selectors and legal/source/install resolution. Designer inspected production in headless Chromium, rendered all mockups, measured art and checked horizontal overflow at every required width. Independent acceptance verdict remains with the CEO's design-judge. This submission does not assert PASS or authorize product implementation/merge.
