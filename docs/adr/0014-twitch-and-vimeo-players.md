# ADR 0014 — Twitch and Vimeo players: allowlist, canonical embeds, playback capabilities

**Status:** accepted (2026-09-30) · [OME-122](/OME/issues/OME-122) · research [`docs/research/m2-twitch-vimeo-sync.md`](../research/m2-twitch-vimeo-sync.md) ([OME-118](/OME/issues/OME-118)) · extends ADR 0002, 0003 and 0011, amends ADR 0012

**Context:** M2 adds Twitch and Vimeo next to YouTube. They differ in what their players can do. Twitch has no rate setter, and a live channel can't seek. Vimeo lets you set the rate only on videos whose owner has a paid plan. The Twitch SDK also builds its own iframe. The wire contract has to say what the providers are, keep "a parsed `Embed` is safe as an iframe `src`" (ADR 0003) true for each one, and let the server and the web client agree on what each embed supports.

**Decision:**

1. **Allowlist.** `PROVIDERS = ["youtube", "twitch", "vimeo"]`.
   - Twitch: live channels and VODs only. We reject clips (they have no JS API), collections, and any URL that sets both `channel` and `video`.
   - Vimeo: public videos and unlisted ones (`h=` hash) only. We reject live events (`/event/…`), showcases without a video, and white-label hosts (`*.videoji.*`, `*.vimeo.work`).
2. **Canonical embeds.** `EmbedSchema` is a variant on `provider` (Twitch's is a nested variant on `kind`). Each variant's `url` must equal the URL rebuilt from its ids:

   | Variant | Ids | Canonical `url` |
   |---|---|---|
   | `youtube` | `videoId` `[A-Za-z0-9_-]{11}` (unchanged) | `https://www.youtube.com/embed/<id>` |
   | `twitch` / `live` | `channel` `[a-z0-9_]{1,25}`, lowercased, not a reserved page name | `https://player.twitch.tv/?channel=<login>` |
   | `twitch` / `vod` | `videoId` `[1-9][0-9]{0,11}` | `https://player.twitch.tv/?video=v<id>` |
   | `vimeo` | `videoId` `[1-9][0-9]{0,11}`, `hash` `[0-9a-f]{6,32}` or null | `https://player.vimeo.com/video/<id>[?h=<hash>]` |

   `canonicalizeEmbed()` accepts exactly the input forms in research §3 and rejects everything else. That includes userinfo, ports, lookalike or other subdomains, extra path segments, repeated parameters, and any id outside its charset. Parameters used only at render time (`parent`, `autoplay`, `dnt`, …) are added by the web client and never sent over the wire. `MAX_EMBED_URL_LENGTH = 128` bounds every canonical URL (the longest is about 70 characters).
   - *Valibot note:* `v.variant` recurses straight into a nested variant's options, so a pipe on the nested variant never runs. The canonical-url check therefore goes on each Twitch object, not on the `kind` variant.
3. **Capabilities.** `playbackCaps(embed)` in `@omega/shared` is pure and returns shared frozen objects. Server and web both use it. Nothing goes over the wire:

   | Embed | `seek` | `live` | `rate` |
   |---|---|---|---|
   | YouTube | true | false | `"yes"` |
   | Vimeo | true | false | `"probe"` (the adapter probes at runtime and falls back to seek-only) |
   | Twitch VOD | true | false | `"no"` (seek-only from the start) |
   | Twitch live | false | true | `"no"` |

   For a `live` embed the web sync loop uses a fourth `RateMode`, `live`: it only matches play/pause, with no drift samples and no seeks. The server stores `position: 0`, ignores the `position` in `control`, and never derives `seek`.
4. **`control` names the embed by its canonical `url`** (`≤ MAX_EMBED_URL_LENGTH`) instead of a YouTube `videoId`. The server compares it with the room's `embed.url`. A mismatch gets `error: no_embed`, as before. This breaks old clients, which is fine because the web client and the server deploy together (ADR 0003). `PlaybackState`, `RoomState` and `embed-changed` keep their shapes.
5. **Iframes.**
   - **Vimeo:** `tvFrame()` still builds every Vimeo iframe (ADR 0011 pattern), with ADR 0011's sandbox, `allow="autoplay; fullscreen; picture-in-picture; encrypted-media"`, `referrerpolicy="strict-origin-when-cross-origin"`, and the fixed parameters `dnt=1&autopause=0&autoplay=1&keyboard=0&controls=0&title=0&byline=0&portrait=0`.
   - **Twitch (exception):** the official SDK must build its own iframe, since it can't attach to ours. We hand it a frozen options object derived only from the parsed embed (`channel` or `video: "v"+id`, `parent: [location.hostname]`, fixed size and autoplay). Straight after `render` the adapter checks for exactly one child iframe, a `https://player.twitch.tv` origin, and `channel`/`video` equal to the embed's. If any check fails, it removes the container and shows the error notice.
   - **Accepted Twitch sandbox deviations:** `allow-modals` and `allow-storage-access-by-user-activation`; its `allow` is `autoplay; fullscreen`. There is still no `allow-top-navigation*` and no `allow-forms`.
   - **CSP additions**, exact files only:
     - `script-src https://player.twitch.tv/js/embed/v1.js https://player.vimeo.com/api/player.js`
     - `frame-src https://player.twitch.tv https://player.vimeo.com`
   - Our code adds no `message` listener. The SDKs' `event.source` checks are the only postMessage gate.
6. **Amendment to ADR 0012, TV minimum:** `roomLayout` takes a minimum per provider. Twitch's player refuses to go below 400×300, so the Twitch minimum is 534×300 (16:9). The others keep 356×200. Below the minimum the page scrolls sideways, as ADR 0012 already says.

**Until the provider frames land ([OME-124](/OME/issues/OME-124)):** `tvFrame()` returns null for any embed that isn't YouTube. A shared Twitch or Vimeo embed shows the empty TV rather than a frame built with YouTube's parameters.

**Consequences:**
- The extension's scanner can already detect Twitch and Vimeo URLs, because it only calls `canonicalizeEmbed`.
- The largest `Embed` grows from about 70 B to about 110 B, and `control` by about 60 B. Both stay far below the frame caps.
- The Twitch SDK sends `referrer=<full room URL>` to Twitch (see the tunnel research, OME-119).
- The live spread budget (board question B1) and the Twitch Developer Agreement review (B2) are still open. Neither changes this contract.
