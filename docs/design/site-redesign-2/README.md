# Website redesign: Doorstep desk — prototype review

This folder holds throwaway prototypes on branch `proto/site-redesign-2`. These HTML files are static review drawings, not product code. The council recommends building direction D; implementation and production validation remain separate work.

Open [entry-A.html](entry-A.html), [entry-B.html](entry-B.html), [entry-C.html](entry-C.html), or [entry-D.html](entry-D.html) for the landing pages; open [room-A.html](room-A.html), [room-B.html](room-B.html), [room-C.html](room-C.html), or [room-D.html](room-D.html) for the rooms. No build step is needed. The floating bar and ← / → keys switch directions; its page link switches between entry and room. Text fields and D's tablist keep their own arrow keys. `switcher.js` is prototype tooling, not part of any design.

A, “Front door”: a cream doorstep card over a full-bleed pixel room, followed by a cinema with a room strip and tabbed conversation panel.

B, “Notice board”: an editorial page with large named avatars and a numbered welcome, paired with a two-column watch-and-chat desk.

C, “Handheld”: a compact framed entry device and a room-wide HUD with floating video, conversation and icon tools.

D, “Doorstep desk”: the council's combination takes A's full-bleed doorstep and cinema, B's numbered name → look → enter sequence, large avatars and visible invite, and C's compact icon tools. Later revisions remove the duplicate rail, keep zoom keys on the scene and use page scrolling when space runs out.

Three reviewers judged the submissions: Claude Opus 5.5, GPT-6-Astra and GPT-6.1-Sol. Scores below are Overall out of 10; final-round parentheses give A11y / Responsive / Beauty. The reported current-site overall range was 7–8.5.

| Submission | Opus | Astra | Sol | Verdict |
|---|---:|---:|---:|---|
| Round 1 · A | 8.5 | 8 | 7.7 | Opus and Astra would ship A |
| Round 1 · B | 7.5 | 7.5 | 8.2 | Sol would ship B |
| Round 1 · C | 7 | 7 | 7.7 | Compare against A and B |
| D · round 2 | 8 | 8.5 | 8.5 | Continue refining D |
| D · round 3 | 7.5 | 8.5 | 8.5 | Sticky entry regression; subsequently undone |
| D · round 4 | 9 | 8.5 | 8.8 | All three recommend building D |
| D · round 5, final | 9 (9 / 9 / 9) | 8.7 (9 / 8.5 / 8.5) | 8.8 (9 / 8.5 / 9) | All three: build D |

The prototypes use system fonts, original room and avatar art from the repository, relative asset paths and no external resources. No web fonts, CDNs or new images were added. Pixel art stays at integer scales with `image-rendering: pixelated`; framing crops the room instead of shrinking it.

Known gaps: labelled playback, chat, queue, invite and room controls are static. Install links open installation notes, not store listings. Colour and accessory choices do not alter the original avatar sprites. Sample guests, messages, queues and invite URLs are illustrative.

Engineering must preserve the provider minimums documented in [apps/web/src/layout.ts](../../../apps/web/src/layout.ts): YouTube 200×200 CSS pixels; Twitch 400×300 in portrait, or 534×300 for a 16:9 landscape player. Letterbox where necessary and size against both available width and height; never shrink below the provider minimum to force a viewport fit.

Reserve at least 200px for the desktop room strip and 96px on short phones, framing the local avatar and its tag. Preserve real tablist semantics, linked tabpanels, selected state, roving focus and Left/Right/Home/End navigation. Keep the phone composer docked within reach. When player, transport, room and controls cannot all fit, scroll the page, never an inner scroller; nothing may be clipped. Use 16px inputs on iOS to avoid focus zoom.

Local checks covered markup, asset references, tab and nickname behavior, contrast and layout calculations. This worker could not run browser verification because the sandbox blocked Chromium. The council scores are supplied review results, not a production acceptance test.
