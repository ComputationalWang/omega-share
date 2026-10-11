# Engineering handoff — Dusk doorstep

## Scope and routing

Proposed product files for Lead: `apps/web/index.html`, `apps/web/src/style.css`, `apps/web/src/main.ts`, `apps/web/src/home.ts`; existing source/install build helpers remain the URL authority. Proposed asset: `assets/site/website-room.png`. These are proposed engineering paths, not Designer claims. Designer changed only `assets/site/**` and `docs/design/website-redesign/**`.

Keep `#landing`, `#nickname`, `#nickname-error`, `[data-testid=avatar-option]`, `[data-testid=join-button]`, `.welcome`, `#how`, `.install`, `#home-root`, `.site-footer` and all six footer test IDs. Replace geometric avatar backgrounds with the existing 512×256 avatar PNG; IDs 0 Juno, 1 Pip, 2 Mo, 3 Kiki remain unchanged. Each named frame `<name>/idle/se/0` is 32×64; use existing JSON rectangles at build time for DOM background-position, without loading Pixi or a JSON runtime parser. Anchor/pose contracts are unchanged.

Entry primary action reads **Enter lobby** on `/`, retaining current validation, profile saving, autoplay gesture and lobby entry. On `/r/<id>` it reads **Enter room** and continues to that exact room, preserving invite-key consumption before SDK loading. Secondary **Find or create a room** validates/saves the profile then switches the existing home root into the directory screen on `/`. It does not create/join a room or warm the renderer. A returning valid profile sees the directory; Edit profile switches back to entry and focuses nickname. Invalid/missing profiles visiting a room link still see entry. Use existing URL routing/history semantics, not a new `/directory` backend route. HTML filenames here are review documents only.

Directory: retain `.create-room`, `.rooms-yours`, `.rooms-public`, `.room-list` and test IDs `create-room-form`, `create-room-title`, `create-room-private`, `create-room-submit`, `create-room-error`, `your-rooms`, `your-room-link`, `your-room-forget`, `public-rooms`, `public-room-link`. Preserve public/private checkbox, creation limits, owner/invited indicators, stored keys, Forget action and existing errors. Escape server titles via textContent; samples are illustrative. Real room names, member counts and role replace samples. Do not invent public/private membership or persist new credentials. Saved room links remain available while public fetch fails. Open rooms/Make a room anchors provide quick phone access; target headings/inputs must receive focus when navigated.

Keep the room runtime, queue, TV, chat, M10 composer/portrait layout and keyboard behavior unchanged. Scope site styles under `.welcome`, `.home`, header/footer; never use the mockup's unscoped demo selectors in the application. Existing room fullscreen/popout footer rules still apply. Use a separate site CSS module if needed to avoid room regressions.

## Layout, type and pixels

System font only: system-ui, sans-serif. Body 16px/1.5; supporting/footer 13–14px; headings 40px/1.12 desktop entry, 32px phone and directory desktop, 28px phone directory. Label 14px/650; primary 16px/750. No external fonts.

Spacing scale: 4, 8, 12, 16, 20, 24, 32px. Wrapper max-width 1104px including 24px side padding, centered. Header 76px; top content gap 32px. Entry columns 360px + minmax(0,1fr), 24px gap. Room crop displays 656×536 without scaling, clipped only if necessary. Directory columns 328px + minmax(0,1fr), 32px gap. Lists are plain rows with 16px vertical padding and a 1px divider. Inputs and primary actions 48px; secondary hit areas at least 44px. Border radius 4px with restrained 4px honey bottom edge on primary actions. No room card grid, carousel or animated decoration.

At ≤700px: wrapper side padding 16px; header 64px; 24px initial gap; single-column flow with min-width:0 on grid children and fieldsets. Mobile order: room vignette, title, nickname, avatar choice, enter action, directory action, steps, installation, footer. Directory keeps creation then saved/public rooms in DOM/keyboard order; quick anchors at the top make joining easy. 360px and 412px verified without horizontal document overflow. Tablet 701–1103px: reduce entry to one column or hide wide hero in favor of the phone vignette before columns would clip controls. Keep hero art at integer scale/native size with overflow-hidden framing; no image interpolation. At ≥1104px use desktop columns. At 1920px do not stretch type, form or art.

Desktop art reserves 656×536; mobile reserves a 154px-high framed viewport over the existing 368×224 `how-3-watch.png`, centered/cropped, not shrunk. Avatar sprites stay 32×64. `image-rendering:pixelated`, explicit dimensions and rounded positions. The original 2:1 floor is unchanged. Decorative imagery can have empty alt text in production; readable form/avatar names must be actual DOM text. The mockups include descriptive alt text for review.

## Palette and accessibility

| Token | Value | Use |
|---|---|---|
| canvas | #201b2b | page |
| surface | #34283d | creation/selected avatar |
| input | #17131f | input fill |
| text | #f8eedb | primary text |
| muted | #d1c0d4 | supporting text |
| honey | #f3cf83 | action, links, focus |
| wood | #ae8047 | button lower edge |
| mint | #b9dfd5 | count/status accent |
| error | #ffc5b9 | errors |
| control border | #9d85a5 | inputs/buttons |
| divider | #69556e | decorative separators |

Measured contrast: text/canvas 14.56:1, muted/canvas 9.74:1, honey/canvas 11.22:1, error/surface 9.19:1, control-border/input 5.51:1. Divider is decorative, not the only control boundary. Focus uses 3px honey outline with 4px offset; selected avatar has a 2px honey border plus aria-checked, so focus and selection differ. Button text uses canvas on honey. Verify all actual shipping states with axe and keyboard after implementation.

Preserve skip link, labels and fieldset legend. Avatar radios use existing roving tabindex and arrow-key behavior; add original avatar names to accessible labels. Tab order follows visual order, including footer links. Enter submits relevant form; error focus moves to the invalid input. aria-invalid and aria-describedby on errors; polite live status for nickname/create/list changes. Retry is an actual button, not a dead link. While submitting, disable Create room, show Creating room…, keep form values; restore actionable error and focus after failure. Focus should never disappear behind a clipped image or sticky header.

No added motion. Loading skeletons are static. `prefers-reduced-motion:reduce` disables any inherited site transitions/smooth scrolling. No hover-only instructions. Long titles wrap without covering counts/actions. Clear owner/invited labels and Forget buttons remain at 44px height on phone.

## State mapping

- Nickname focus and invalid: `states-*.png` first row. Use existing validation messages (empty, unsupported chars, >20 chars), retain input content and selected avatar.
- Public loading: set list aria-busy=true; polite Finding rooms… with two static bars. Reserve at least two row heights; do not replace creation/saved room content.
- Public empty: only a successful empty response says No public rooms right now. Saved empty says No saved rooms in this browser yet. Clear aria-busy.
- Fetch/network/invalid-response error: Could not reach the server. Try again. + Retry. Current home.ts conflates failure and empty; engineering must distinguish them without changing wire contracts.
- Creation: retain exact existing error-code copy, rate-limit retry timing, storage errors and private flag. Render adjacent to input/action; do not navigate until keys are stored. Submission/failure panels on the state sheet are alternative snapshots, not simultaneous product UI.
- Directory long/loading states: footer stays after content, no absolute bottom position, no decorative minimum page height. Legal links remain usable before/after profile entry.

## Footer destination audit and legal coordination

Researcher and designer inspected production `https://omega-share.duckdns.org`, deployed 979e608 on 2026-10-11. All six links returned HTTP 200; none are dead or placeholder URLs. **Keep all six.** Placeholder legal content is a separate problem, not a reason to remove Contact.

| Label | Production destination | Resolution |
|---|---|---|
| Privacy | https://omega-share.duckdns.org/privacy.html | root-relative /privacy.html |
| Terms | https://omega-share.duckdns.org/terms.html | root-relative /terms.html |
| Contact | https://omega-share.duckdns.org/contact.html | root-relative /contact.html |
| Licences | https://omega-share.duckdns.org/licenses.html | root-relative /licenses.html |
| Source | https://github.com/ComputationalWang/omega-share | source.ts + VITE_SOURCE_URL at build |
| Feedback | https://github.com/ComputationalWang/omega-share/issues | same resolved source base + /issues |

Source/Feedback remain target=_blank with rel=noopener noreferrer. Legal pages stay same-tab and accessible without profile. Preserve AGPL source access, CC BY-SA art credit and existing runtime build-version token; do not ship the demo's “Build version shown at runtime” text.

Production Contact had operator/language “Not published yet” blocks during inspection. OME-914 legal facts are now merged at origin/main 83073cc; this design branch starts there. Preserve those approved pages verbatim; no new email, jurisdiction, age, warranty or response-time claims in the redesign. Deployment must serve that legal update before public-release acceptance; HTTP 200 alone does not establish legal completeness. Footer does not replace legally required operator information on Contact.

Extension listings remain null in install.ts. Show Firefox: coming soon / Chrome: coming soon, as rendered. Once the approved constants are real store URLs, use existing build substitution and plain 44px-tall Add to Firefox/Add to Chrome links. Never fabricate a store href, use #, or add badges from remote hosts. Both installed/coming-soon variants share the same fixed-height row allocation.

## Transfer allocation and verification

Measured runtime asset inventory (`inventory.json`): 181,682 bytes including existing site icons/how illustrations and the new 20,963-byte room crop; budget 307,200 bytes. This conservative total covers every PNG/ICO and gzipped JSON/CSS in avatars, room, ui, furniture and site, excludes previews/src/store promotional renders. The older build reporter omits site art, so do not cite that smaller number. Pending separately judged preset assets are not on this branch; reserve their previously reported 20,478 bytes, yielding 202,160 bytes, still within budget. Recalculate on final merge SHA.

| Landing asset | Dimensions | Compressed bytes |
|---|---|---:|
| new website-room.png | 656×536 | 20,963 |
| existing avatars.png | 512×256 | 4,426 |
| existing how-3-watch.png | 368×224 | 3,231 |
| Total if all three fetched | | 28,620 |

Use `<picture>` so only desktop crop OR mobile vignette is fetched; no hidden duplicate image requests. Desktop primary art+avatar =25,389 B; mobile=7,657 B. Directory may reuse mobile vignette, loaded after directory intent. Do not fetch avatar JSON, motion/room/furniture atlases, Pixi, providers or video for landing. No preload of room modules until the existing explicit room intent; profile/directory focus must not warm the renderer. Preload only matching hero if needed; explicit size and system font avoid layout shifts.

Proposed maximum pre-interaction allocation (120 KiB=122,880 B): HTML 8 KiB, initial JS 55 KiB, CSS 14 KiB, static art/icons 30 KiB, reserved overhead 13 KiB. This is an engineering allocation, not a measured app-performance claim. CSS growth target ≤4 KiB gzip incremental, JS growth ≤2 KiB incremental for directory switching/state semantics; split room/renderer code remains lazy. Independently retain initial site JS ≤200 KiB gzip; local TTI <1.5s, LCP <1.5s, CLS ≤0.05, longest task ≤50ms. Browser cache must not be used to hide first-load transfer costs.

Lead validation: production build with real URL substitution; check actual gzip bytes and cold-load request waterfall on 360/412/1280/1920; landing perf on controlled local environment; keyboard + axe through every state; regression checks for existing create/join/private links, forget/storage/rate-limit handling and install substitution; existing M10 portrait/composer regression selection. Headed real-provider checks use the required X11 xvfb wrapper. Mockup PNGs/HTML and their inline images never ship. No full app tests were claimed by Designer: this change is design/asset-only, with renderer overflow checks and byte/contrast measurement.

## Review and implementation sequence

Lead contract sub-issue OME-934 covers this static asset/component handoff. CEO must inspect actual PNGs through an independent design-judge (design-judging rubric); Designer provides no acceptance verdict. This is round 1, max three failed revision rounds before board escalation. Product engineering begins only after that independent acceptance. Asset PR remains draft while CI runs; engineering review/ready PR requires green CI. Lead owns asset merge after normal native review gates. No website application code was changed.
