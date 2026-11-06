# Engineering handoff — Doorstep desk, atlas hybrid

## Scope & routing

These are standalone review drawings. Implement entry in `apps/web/index.html`, `apps/web/src/style.css` and `apps/web/src/main.ts`; keep the existing profile/directory behavior in `src/home.ts`. Room chrome belongs in `apps/web/src/room.css` and the DOM-building portions of `apps/web/src/room.ts`.
`apps/web/room.html` currently boots the room pop-out through `src/popout/room-page.ts`; it is not the main room template. Update only its shared chrome integration as needed, retaining `#popout`, `.ui-room`, `.popout-page`, `.poproom-page`, `.site-footer`, `.popout-footer` and `[data-testid=source-link]`.
Do not change room routing, invite-key consumption, autoplay gesture, profile persistence, sockets, room runtime, sync, queue semantics, TV/provider adapters or chat protocol. DOM chrome work must not alter the PixiJS stage geometry, walking, room camera or render loop. The separately scoped scene-UI issue below may change presentation containers, never those contracts.
`Enter lobby` on `/` enters the lobby; `Enter room` on `/r/<id>` continues to that exact room. `Find or create a room` validates/saves the profile and opens the existing directory; it does not enter/create a room or warm Pixi. Returning profiles retain the current directory and Edit profile flow. Do not ship these filenames or inline prototype scripts.

Keep entry selectors from the previous handoff: `#landing`, `#nickname`, `#nickname-error`, `[data-testid=avatar-option]`, `[data-testid=join-button]`, `.welcome`, `#how`, `.install`, `#home-root`, `.home`, `#room-root` and `.site-footer`. Keep avatar IDs 0 Juno, 1 Pip, 2 Mo, 3 Kiki, existing native/radio keyboard behavior and sprite anchors.
Use `assets/avatars/avatars.png` (512×256), with the JSON's 32×64 `<name>/idle/se/0` rectangles resolved at build time. Do not fetch avatar JSON or load Pixi on the landing page.
Keep directory classes `.create-room`, `.rooms-yours`, `.rooms-public`, `.room-list`; test IDs `create-room-form`, `create-room-title`, `create-room-private`, `create-room-submit`, `create-room-error`, `your-rooms`, `your-room-link`, `your-room-forget`, `public-rooms`, `public-room-link`. Also retain `find-room`, `edit-profile`, `public-rooms-status`, `public-rooms-retry`, `your-room` and `rejoin-chip` from the current e2e contract.
Keep footer test IDs `privacy-link`, `terms-link`, `contact-link`, `licenses-link`, `source-link`, `feedback-link`, plus `build-version`. Preserve legal pages, source/feedback URLs, build token, AGPL source access and original-art CC BY-SA credit; do not copy prototype version strings or sample URLs.

The following are `data-testid` values from `e2e/support/selectors.ts`; map D's chrome to them instead of changing the selector contract:
- Room/video: `room`, `room-title`, `tv`, `tv-empty`, `shared-video`, `room-window`, `leave-key`, `mute-toggle`, `volume`, `play-toggle`, `seek`, `time-current`, `time-duration`, `unmute-button`, `tv-hint`, `system-line`, `catching-notice`, `sync-notice`, `room-notice`, `connection-status`.
- Conversation/scene: `chat-input`, `chat-send`, `chat-message`, `chat-log`, `chat-log-line`, `emote-key`, `palette-key`, `palette-item`, `nickname-tag`, `walk-floor`, `seat`, `lie-key`. Preserve DOM focus targets for walking/seating when visual cursors move into Pixi.
- Queue/invite: `queue-panel`, `queue-count`, `queue-row`, `queue-remove`, `queue-move-up`, `queue-move-down`, `queue-status`, `queue-next`, `queue-url`, `queue-add`, `queue-problem`, `invite-link`, `invite-copy`.
- People/help: `people-key`, `people-panel`, `people-row`, `people-toggle`, `people-walk-over`, `people-follow`, `people-conga`, `people-status`, `follow-chip`, `follow-stop`, `snap-key`, `help-key`, `help-dialog`, `help-close`, `help-tips`, `first-hint`, `hint-next`, `hint-skip`.
- Full screen/pop-outs: `fs-root`, `fullscreen-toggle`, `fs-strip`, `fs-strip-toggle`, `fs-chat-toggle`, `fs-bubbles`, `chat-popout`, `chat-away`, `chat-bring-back`, `popout-back`, `popout-people`, `popout-gone`, `popout-open-room`, `room-popout`, `room-away`, `room-bring-back`, `room-show-window`, `poproom-room`, `poproom-chat`, `poproom-plate`.
- Reporting: `report-key`, `report-dialog`, `report-reason`, `report-note`, `report-count`, `report-cancel`, `report-send`, `report-sent`, `report-already`, `report-close`, `report-leave`, `report-failed`, `report-failed-text`, `report-retry`.
Other editor, moderation, doors, generic-load, refusal and recovery selectors remain owned by their existing components. D does not remove those features or authorize changing their test IDs.

## The hybrid rule

DOM owns navigation, forms, transport, queue, invite, tablist, People, dialogs and footer. Style these with generated `assets/ui/reference.css` helpers and PNG `border-image` slices; never hand-edit generated reference CSS or ship a second frame palette.
PixiJS owns the room picture and the scene-bound visuals: name tags, speech bubbles, reactions, seat cursor and floor hint chip. Load the same `assets/ui/ui.json` frames; each frame's `borders` supplies `NineSliceSprite` insets. Keep atlas pixels at integer scale: page chrome `--ui-px: 2px`, scene `.ui-room` at 1×; the existing TV shelf has its explicit 1×/44px reference contract.
Today `room.css` positions `.tags`, `.bubbles` and `.reactions` as DOM layers over the canvas. Move their visuals into the existing scene container so camera/avatar movement is one transform rather than per-frame DOM repositioning. Reuse pools and the existing stepped bubble clock; do not add another renderer, socket, ticker or animation system.
The DOM must retain an offscreen `role=log`, `aria-live=polite` region mirroring chat and system lines once, in order; People must list every name tag, including the local avatar. Retain accessible floor/seat controls and reaction labels. Nothing actionable or meaningful becomes canvas-only. Prototype tags/logs remain DOM examples, not the migration itself.

## Layout

Below 1024px, stack video, transport and a native-size cropped room above the panel; tab keys and composer stay sticky within reach. At 1024px and above use two columns; the panel is 300px at 1024–1279px and 360px above, always at least 280px. The entry card is 512px on desktop and flows naturally with the page on smaller screens; never restore its inner scroller or sticky Enter block.
Desktop video uses both available width and height with a 534×300 Twitch landscape floor where it fits. Phone video takes the column width subject to available height, minimum 200px high for YouTube; Twitch requires 400×300 portrait, or 534×300 to preserve 16:9 landscape. Read `src/layout.ts` before changing provider calibration; letterbox rather than crop the player.
Reserve at least 200px of room on desktop and 96px on short phones. The short two-column budget subtracts the full 200px strip. On short phones use three 44×44 zoom keys; frame the image and its attached tags together so Juno remains visible. Never put chrome over the actual player rectangle.
D's baseline top bars are 77px desktop / 68px phone, transport budgets 112px / 88px, and phone sheet reserve 276px before atlas frame/content growth. Reconcile actual atlas borders and 48px field heights in the measured layout; these constants are not permission to clip content. When provider minimums plus controls do not fit, grow and scroll the page, never an inner cinema or chat box.

## Tokens & frames

System font only: `system-ui, sans-serif`. Body 15px/1.5, entry heading 34px desktop / 30px phone, step heading 17px, room heading 18px / 14px, supporting text at least 12px; editable/read-only text fields 16px for iOS. Original avatars stay at 3× desktop / 2× phone; the room stays at 1× or 2× and is cropped, not resampled.
| D role | Token / value | Atlas treatment |
|---|---|---|
| Canvas | `--ui-page: #191927`; room `#171620` | Quiet background |
| Doorstep | `--cream: #fff3d9`; ink `#292333` | `panel/0` border without centre fill |
| Dark panel / field | `--ui-panel: #332b3a`; `--ui-field: #24264a` | Native panel and field fills |
| Text / supporting | `--ui-text: #fff7ea`; `--ui-muted: #c7c2d3` | Cream and lilac relationships retained |
| Focus / selected | `--ui-accent: #f4cd83` | Honey outline; atlas primary face remains native `#e8b33c` |
| Primary / bubble ink | `--ui-on-primary`, `--ui-bubble-text: #2b1d2f` | Native plum on mustard or cream |
Enter, Say, Copy and Add use primary button slices; Leave, zoom, tabs, disclosure keys and install/directory links use secondary; Report uses danger, with the disabled slice while unavailable. Nickname uses the input frame without centre fill on cream; other fields use the inset atlas well and invite uses the ticket frame. Radio swatches and avatar caption keys use the same button states. Chips and sync lamps are native atlas sprites.
Use the reference seek/volume frames where suitable; D's native range inputs demonstrate a matching plum outline, top-left light and honey thumb with a 44px hit box. Keep `var()` out of `border-image` shorthands as the existing performance notes require; use variables in border widths instead.

## Motion

Hover swaps to the matching `-hover` slice and pointerdown/`:active` to `-press`, immediately: 0ms, no border/background interpolation. Disabled controls keep their disabled frame; release restores the current selected/idle frame. Keyboard focus stays visible while pressed.
Panel/disclosure content enters with opacity 0→1 and translateY 6–8px→0 over 140ms ease-out. The active tab underline slides by transform over 140ms. Sheet height changes commit layout once, then translate the sheet from its previous lower edge over 160ms ease-out; never animate `height`, padding, borders, grid tracks or other layout properties, and never scale pixel frames. Cancel a superseded transition; no added transition exceeds 200ms.
Entry → room: show Enter's press slice immediately; render the room top bar and transport first, then fade the scene under them over 160ms. Keep the existing gesture/autoplay path and loading indication. The standalone pages deliberately show the settled end state, without a page-load entrance animation.
Under `prefers-reduced-motion: reduce`, all transition durations are 0ms, animated transforms are absent and content/selection changes immediately. Turning reduced motion on cancels running Web Animations; the underline uses direct positioning. No idle pulsing, looping lamp or decorative motion is added.

## Accessibility & validation

Keep skip links, header/main/aside/footer landmarks, headings, labels, legends and error associations. Native avatar/colour/accessory radios keep keyboard selection. Tabs use `tablist` / `tab` / `tabpanel`, `aria-selected`, `aria-controls`, linked labels and one tab stop; Left/Right wrap, Home/End jump and focus follows selection. Stop those arrows reaching prototype navigation.
All keys, fields and footer links remain at least 44×44px. Focus is a 3px honey outline with 4px offset; on the cream doorstep a plum backing ring keeps it distinct. Selection includes a check/state marker, not colour alone. Preserve the 16px input rule, accessible live statuses and focus return after dialogs/errors.
Computed text contrasts against actual slice fills: primary plum/mustard 8.29:1, secondary cream/blue 7.86:1, disabled text/charcoal 5.27:1, D text/panel 11.99:1, bubble plum/cream 13.30:1, nickname placeholder/light field 6.08:1. Honey/plum focus is 8.99:1. These are colour calculations, not a browser/axe acceptance claim.
Verify cold-load transfer and [all performance budgets](../../../docs/perf-budgets.md): initial JS ≤200KB gzip; landing transfer ≤120KB, LCP ≤1.5s, CLS ≤0.05; join/loading and frame budgets still apply. Scene migration must hold 60fps, ≤16.7ms frame p95, ≤8ms work p95, ≤1% missed vsyncs and ≤150MB after 10 minutes, including phone, 25 walkers, chat/reaction bursts and pop-outs. Measure; do not infer performance from fewer DOM nodes.

## States to implement

Nickname invalid: preserve the value, show the existing message with `aria-invalid`/`aria-describedby`, and focus the field. Keep selection and validation/storage error behavior. Loading must show Opening the room… within the existing 100ms budget, without warming room assets before intent.
Empty TV: preserve the empty illustration/title and an actionable queue path. Provider hint: keep the provider's gate/seek-only/unsynced explanation beside the player; never imply generic embeds are synced. Error/Reload: reconcile [PR #862](https://github.com/ComputationalWang/omega-share/pull/862) before implementation, preserving its exact recovery behavior and accessible error copy; its contents were unavailable during this handoff, so this prototype does not define a replacement contract.
Long titles must wrap without covering controls. People must retain names, local identity, hide/follow/moderation states and live updates. Preserve queue empty/loading/error/full, invite-copy failure and connection/rejoin states. Full screen may optionally borrow C's HUD while keeping the real player unobscured and the accessible DOM composer/People available; it is not the default layout.

## Suggested Paperclip slices — one issue each

1. **Atlas on entry** — `index.html` / `style.css` only; keep IDs, test IDs, routing and all controls.
   Acceptance: start with red landing + a11y-sweep e2e assertions for the new frame/focus behavior; make them green at required widths, with keyboard/error states and the cold landing budget passing.
2. **Room chrome layout** — room HTML/CSS and existing DOM creation: top bar, transport, tablist panel, persistent invite and docked phone composer.
   Acceptance: preserve mapped selectors and provider minimums; 360/412/768/900/1024/1280/1920 layouts expose controls and local avatar, using page fallback without clipping or inner scrolling.
3. **Scene-bound UI into Pixi** — pooled tags, bubbles, reactions, cursor and floor hint using atlas `NineSliceSprite` frames in the existing scene container.
   Acceptance: DOM live log/People/floor controls retain equivalent access and tests; all relevant [performance rows](../../../docs/perf-budgets.md) pass on the final change, with no runtime/protocol or geometry regressions.
4. **Motion, press and reduced motion** — immediate atlas states, 140ms content/tab and 160ms sheet/entry sequencing.
   Acceptance: keyboard and pointer states match; reduced motion has no animations/transforms, cancellation is correct and no layout property is animated or task/frame budget exceeded.
5. **Full-screen HUD, optional** — C's floating-window/room-world idea only within existing full-screen mode.
   Acceptance: player minimums and visible accessible controls survive enter/exit, Esc, keyboard and pop-outs; preserve fullscreen selectors and its CLS/task/frame budgets.

Prototype verification covers structure, atlas references, contrast calculations and interaction assertions. Browser execution is blocked by this worker's sandbox; actual render, screen-reader, provider, perf and PR #862 recovery verification remain engineering checks. No production files, protocols or renderer migration were implemented here.
