# ADR 0024 — Generic (unsynced) embeds: any safe https embed, sandboxed, click to load

**Status:** accepted (2026-10-01) · board direction [OME-285](/OME/issues/OME-285) · contract [OME-290](/OME/issues/OME-290) · server [OME-291](/OME/issues/OME-291), web [OME-292](/OME/issues/OME-292), extension [OME-293](/OME/issues/OME-293) · amends ADR 0003, ADR 0011 §CSP, ADR 0014 §5

**Context:** Until now a room could show only YouTube, Twitch and Vimeo. Their players can be synced, and the extension and the server both rejected every other URL (product spec, "Providers"; CLAUDE.md "never render arbitrary iframes"). The board wants rooms to accept **any other embed** too. This ADR reverses the allowlist-only rule and sets out how to do it safely. Two things stay the same: the three synced providers keep their adapters, sync and tests, and no iframe is ever built from a string that has not been parsed by `packages/shared`.

## Decision

Embeds come in two tiers:

| Tier | Providers | Synced | Wire type |
|---|---|---|---|
| **Synced** | YouTube, Twitch, Vimeo (`SYNCED_PROVIDERS`) | yes, ADR 0002/0011/0014 | `Embed` (unchanged) |
| **Generic** | any other URL that passes §1 | **no**: each viewer plays it on their own, and the UI says so | `GenericEmbed = { provider: "generic", host, url }` |

On the wire, `AnyEmbed = Embed | GenericEmbed` (`AnyEmbedSchema`) replaces `Embed` in `RoomState.embed`, `embed-changed.embed` and `ShareResponse.embed`.

### 1. URL validation (`packages/shared`, `canonicalizeGenericEmbed`)

The function is pure and never throws. It returns `null` unless every rule below passes:

- The raw input is at most `MAX_URL_LENGTH` (2048). It is trimmed and parsed with the WHATWG `URL` parser, which is the same parser the browser uses for the iframe, so what we validate is what gets loaded.
- **Scheme:** the scheme must be `https:`. That rejects `http:`, `javascript:`, `data:`, `blob:`, `file:`, `ftp:`, `ws(s):` and everything else.
- **No userinfo** (`user@`, `user:pass@`) and **no explicit port**. `:443` is normalised away; any other port is rejected, which stops probing of local services.
- **Host must be a public DNS name:**
  - It needs at least two labels. Each label is `[a-z0-9-]{1,63}` with no hyphen at either end, and the whole name is at most 253 characters. A trailing dot, `_` and empty labels are rejected.
  - The last label must be alphabetic or punycode. The URL parser rewrites any host whose last label is numeric or hex into a dotted IPv4 address (`2130706433`, `0x7f.1` and `127.1` all become `127.0.0.1`), so this one rule rejects **every IPv4 literal**. IPv6 literals (`[::1]`, `[::ffff:127.0.0.1]`) fail the label rule.
  - **Private and special-use names** are rejected, along with all their subdomains: `localhost`, `local`, `internal`, `localdomain`, `lan`, `home`, `corp`, `intranet` and `arpa` (which covers `home.arpa` and `in-addr.arpa`). So are the reserved names that never resolve publicly: `test`, `example`, `invalid`, `onion` and `alt`.
  - **Public DNS that answers with loopback or with an IP written in the name** is rejected, along with subdomains: `localtest.me`, `lvh.me`, `vcap.me`, `localhost.direct`, `nip.io`, `sslip.io`, `xip.io` and `traefik.me`.
- **Not a synced provider's host.** That means `youtube.com`, `youtu.be`, `youtube-nocookie.com`, `twitch.tv`, `vimeo.com` and their subdomains. A synced provider's URL becomes its synced embed or nothing. It never becomes an unsynced iframe, so a YouTube link is always synced, and their non-embed pages refuse framing anyway. Twitch clips (`clips.twitch.tv`) are therefore not accepted for now. Supporting them would be a registry change (§2).
- **Not our own origin.** `opts.ownHosts` lists our hostnames, and those hosts and their subdomains are rejected. The server passes its public host(s), meaning the tunnel/hosted host plus `localhost` in dev. Entries are normalised with `normalizeHostname` (trimmed, lowercase, punycode, no trailing dot). The server runs its configured hosts through it at startup and refuses to start if one is not a bare hostname, so a misconfigured entry cannot silently disable the rule. `GenericEmbedSchema` **cannot** check own hosts, because it has no config. The web therefore refuses to render a generic embed whose host is `location.hostname` or a subdomain of it. That check is required in OME-292, with a test.
- **Canonical form:** `url` is `URL.href`. That means a lowercase punycode host, no default port, resolved dot segments and percent-encoded paths. The query and fragment are kept, because players use them for ids and start times. The result must be at most `MAX_GENERIC_EMBED_URL_LENGTH` (1024). `host` is `URL.hostname`, in **punycode**, so a homograph shows as `xn--…` on the load card instead of passing for a familiar name.
- `GenericEmbedSchema` re-runs the canonicaliser (about 2 µs) and requires `url` and `host` to equal its output. Like every server→client schema, it is a `v.object`: unknown keys are stripped, not rejected. As with the synced tier (ADR 0003), a parsed `GenericEmbed.url` is the only string that may become an iframe `src`.

`canonicalizeAnyEmbed(input, { generic, ownHosts })` is the share path. It tries the synced tier first, then the generic tier if `generic` is on.

**What static validation can't do:** a public name can still resolve to a private address (DNS rebinding, or a hostile zone). **The server never fetches a shared URL**: there is no oEmbed, no thumbnail and no preflight, so this tier adds no SSRF surface. In the browser, the URL loads only after the user clicks (§3), inside the sandbox (§2b). Chromium's Local Network Access checks may also stop a public page from framing a private address, but we do not rely on them. The residual risk is real: a hostile zone with an A record of `192.168.x.x` gets one unauthenticated GET from a viewer's browser after that viewer clicks Load. We accept this, and the denylist (§6) is the response to a known-bad zone.

### 2. Provider registry

`SYNCED_PROVIDERS` in `packages/shared/src/embed.ts` is the synced tier. Each entry is `{ id, ownsHost(host), canonicalize(url) }`. `canonicalizeEmbed` dispatches through it, and the generic tier uses `ownsHost` to stay off synced hosts. A new synced provider is one registry entry plus its `Embed` variant in shared, and one adapter plus its `PLAYERS` entry in `apps/web/src/player/registry.ts`, plus its CSP origins. The generic tier needs no per-site code.

### 2b. Sandboxed render (web, OME-292)

The generic iframe is built in exactly one place (`apps/web/src/tv.ts`) with fixed attributes. Only `src` comes from data, and it comes from a parsed `GenericEmbed.url`:

| Attribute | Value | Why |
|---|---|---|
| `sandbox` | `allow-scripts allow-same-origin allow-presentation` | Players need scripts and their own origin's storage/cookies. The frame's origin is never ours (§1), so `allow-same-origin` does not let it escape the sandbox or reach our DOM. The synced tier's `allow-popups*` is **not** granted. There is also no `allow-top-navigation*`, `allow-forms`, `allow-modals` or `allow-downloads`. |
| `allow` | `fullscreen; autoplay` | Fullscreen is the basic viewing need. Autoplay is justified because Load is the user saying "play this": without delegation, the player needs a second click inside the frame. `encrypted-media` is **left out**. DRM-only embeds fail (accepted), and EME adds a device-identifier and fingerprinting surface for sites we don't vet. Add it only through a new ADR. |
| `referrerpolicy` | `no-referrer` | The site learns nothing about which room or page framed it. Embeds that allowlist by referrer (e.g. Vimeo domain privacy) will refuse. We accept that. |
| `title` | `Shared video from <host>` | Accessibility. |

The page's `Permissions-Policy` header (camera, microphone, geolocation, payment, usb, serial, hid, bluetooth, display-capture all `()`) also binds the frame, whatever it asks for.

### 3. Click to load

A generic embed first renders a **card**: "Video from **host** · not synced · Load". `host` is set with `textContent`. The card makes **no third-party request**: no favicon, thumbnail, oEmbed or preconnect. The iframe is created only when *that* viewer clicks Load. The choice is kept per viewer for the current embed URL and resets when the embed changes. This keeps the room's load and frame budgets independent of third-party pages (`docs/perf-budgets.md`), and nobody is tracked just for being in a room. The sync controls, rate nudges and catch-up status are hidden for the generic tier. A small "not synced" label stays visible after Load. Many sites refuse framing (`X-Frame-Options`, `frame-ancestors`), and we cannot detect that across origins. The web shows a static hint under the frame ("Blank? This site doesn't allow embedding.").

### 4. CSP

`frame-src` becomes `https://www.youtube-nocookie.com https://player.twitch.tv https://player.vimeo.com https:`. The explicit origins are now redundant, but they stay so the synced tier still works if `https:` is removed. `script-src` **does not change**. It keeps the path-scoped SDK loaders (ADR 0011, ADR 0014), and the Trusted Types policy keeps its M4 path from report-only to enforced (`apps/server/src/headers.ts`).

Trade-off against ADR 0011/0014: those ADRs pinned framing to three origins, so an HTML-injection bug could frame only those three. With `https:`, injected markup could frame any https page. Three things mitigate this. We never write HTML from data: there is no `innerHTML`, and the Trusted Types policy will block it once it is enforced. `script-src` still stops injected script. Our `frame-src` governs the frame's initial load and its redirects. It does **not** govern a cross-origin frame navigating itself, which only that document's own policy controls. A hostile embed can therefore move itself to any URL. What bounds it is the sandbox (no top navigation, no popups), mixed-content blocking, and the fact that it stays inside its own frame.

**`frame-src` follows the kill switch.** When `GENERIC_EMBEDS=off`, the server's CSP header drops `https:`. The `<meta>` CSP in `apps/web/index.html` keeps `https:`, and because header and meta policies intersect, the effective policy is the three origins.

### 5. Kill switch: `GENERIC_EMBEDS=on|off`

This is server config. The default is `on`, and any other value fails startup. When the switch is `off`:

- `POST /rooms/:id/share` calls `canonicalizeAnyEmbed` with `generic: false`. A generic URL gets `unsupported_url`.
- A room restored from storage with a generic embed is restored with `embed: null`, so the server never broadcasts a generic embed.
- `frame-src` narrows (§4).

The web and the extension need no flag of their own. The web renders only what the server sends. The extension may still list generic candidates, and the server refuses them with the normal error.

### 6. Abuse controls

- The share rate limits (ADR 0016, ADR 0018) apply to both tiers unchanged.
- **Host denylist hook:** the server checks `isDeniedHost(embed.host)` after canonicalisation. It is backed by `GENERIC_EMBED_DENYLIST`, a comma-separated list of domains where each entry also matches its subdomains. The list is **empty by default**. A denied host gets `unsupported_url`. There is no new error code, so a client can't tell which rule refused it. The hook applies to the generic tier only.

### 7. Wire rules

- A generic embed **never carries playback state**. `playback` must be null in `RoomState` and in `embed-changed` (`playbackMatchesEmbed`), and the schemas reject the message otherwise. The README's server invariant is now: `playback` is null iff `embed` is null **or generic**.
- `control` on a generic embed gets `error: no_embed`, because there is no synced embed to control. `control.url` stays capped at `MAX_EMBED_URL_LENGTH` (128), which is only for synced URLs.
- `status { catching }` is meaningless for the generic tier. The web doesn't send it there, and the server ignores it.
- **Size:** a 1024-character URL plus its host adds about 1.3 KB to a snapshot. A worst-case full-room snapshot stays under 7 KB, well inside `MAX_SERVER_MESSAGE_BYTES` (16 KB). A contract test covers this.
- **Compatibility:** the site and the server ship together (ADR 0015). An older extension that receives a generic embed in a share response fails to parse it and shows its offline/error text. It can only get one if it sent a generic URL, and old extensions only send synced ones.

## Consequences

- Rooms can show almost any embeddable video. Only the three synced providers stay in sync. A generic embed is per viewer, and the UI says so.
- Shared code has a second canonicaliser and one wider wire union. The web gains one card and one iframe recipe. The server gains one flag and one hook. The web bundle grows by well under 1 KB gzipped.
- CLAUDE.md and the product spec drop "never render arbitrary iframes". The rule is now: **never build an iframe from an unparsed string**. A synced embed must parse as `Embed`. Anything else goes through the generic tier, which is validated, sandboxed and click-to-load.
- Accepted losses: framing-refusing sites show a blank frame, DRM-only and referrer-gated embeds fail, links that open new windows inside the frame do nothing, and Twitch clips stay unsupported until they get a registry entry.
