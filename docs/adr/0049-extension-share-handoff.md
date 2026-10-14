# ADR 0049 — `#share=` hand-off from the extension to the home page

**Status:** accepted (2026-10-14) · board request on [OME-1083](/OME/issues/OME-1083) · implemented in [OME-1085](/OME/issues/OME-1085)

## Context

A user who finds a video but has no room yet needs a way into one. The board wants the extension to send them to the website, through the normal nickname, avatar and create-room flow, with the video already filled in. The extension doesn't pick a room type.

## Decision

1. **Format.** The extension opens `${origin}/#share=${encodeURIComponent(url)}`, where `origin` is the site it is configured for. The link goes in a fragment, so it never reaches a server, a proxy or an access log. No other parameters are sent.
2. **Taken once at boot.** `main.ts` reads `#share=` at top level, before any dynamic import, and drops it with `replaceState` (like `#k=`, ADR 0028), so a reload or a copied URL doesn't carry it. A value that doesn't decode, is empty or is longer than `MAX_URL_LENGTH` is dropped silently.
3. **Same parser as the queue.** The lazy home chunk keeps the link only if `canonicalizeAnyEmbed(url, { generic: true, ownHosts })` accepts it. That is a synced provider, or the ADR 0024 generic tier with our own host excluded. Anything else is dropped without a message. The link is only ever rendered as text. The site builds no iframe for it; the room plays it from the server's canonical embed, as for any queue item.
4. **Into the new room through the existing path.** The create form shows "This video will play in your new room: <link>" with "Don't add it". On create, the link waits in `sessionStorage` (`omega.pendingShare.<roomId>`), as a saved layout does (OME-910). Once the owner joins and the first snapshot is in, the room page re-validates it and sends one ordinary `queue-add`, after any pending `layout-set`. **No contract change:** the server validates the URL as it does any queue add.

## Consequences

- If the user goes to the lobby or an existing room instead, or the tab's storage is blocked, the link is lost. That's acceptable: they can paste it, or share it again from the extension.
- With `GENERIC_EMBEDS` off on the server, a generic link is shown here but refused by the server's queue-add, and the room shows its normal queue error.
- Changing the format (key name, encoding, query instead of fragment) breaks shipped extensions, so it needs a superseding ADR.
