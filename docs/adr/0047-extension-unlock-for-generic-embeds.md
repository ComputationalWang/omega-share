# ADR 0047 — Opt-in "Unlock with extension" for generic hosts that refuse to play in a room

**Status:** accepted (2026-10-13), except §3 (Referer), which waits for board sign-off on [OME-1039](/OME/issues/OME-1039) · board direction on [OME-1034](/OME/issues/OME-1034) · spike [OME-1039](/OME/issues/OME-1039) · amends ADR 0024 §2b, §3 and the "Accepted losses" line, and ADR 0005 (extension permissions)

## Context

ADR 0024 accepted that a generic embed whose host refuses to be framed by us shows a blank or error frame. The board wants such hosts (the report was kwik.cx) to play for viewers who have our extension, as TwoSeven does. TwoSeven (3.0.29, MV2) installs with `<all_urls>`, `webRequestBlocking` and `cookies`. It strips `X-Frame-Options` and the whole `Content-Security-Policy` from every frame response on its tabs, and it rewrites `Cookie` on every frame request. That is store-compliant, but its footprint is far larger than we need.

**Spike, real kwik.cx embed from its partner page (headed Chromium under xvfb, [OME-1039](/OME/issues/OME-1039)):**

| Iframe navigation sent with | kwik answers |
|---|---|
| no `Referer` (ADR 0024 `referrerpolicy="no-referrer"`) | 403 Cloudflare block page, with `X-Frame-Options: SAMEORIGIN` on the block page |
| `Referer` = our origin, or another mirror | 403 |
| `Referer` = the partner site | 200 player |
| `Referer` = **`https://kwik.cx/`, the embed's own origin** | 200 player |

The 200 response carries **no** `X-Frame-Options` and **no** CSP. kwik is gated only by a `Referer` allowlist at its CDN; cookies and `Origin` play no part. One DNR rule that sets `Referer: https://kwik.cx/` on the room's frame navigation made the episode play inside the unchanged ADR 0024 sandbox. So there are two kinds of refusal, and the design handles each separately:

1. **Framing headers:** `X-Frame-Options`, or CSP `frame-ancestors`.
2. **Referer gates:** the host refuses a request without an allowed `Referer`.

## Decision

### 1. Opt-in, per viewer and per host

- The generic card (ADR 0024 §3) shows **"Unlock with extension"** next to Load, but only when the extension has announced itself on the page (§5). Viewers without the extension see the card unchanged, with the hint "Some hosts only play here with the Omega Share extension." We cannot detect a refusal across origins, so the hint can't name the host as refusing, and it says "some hosts" (this deviates from the wording in the issue for that reason).
- Clicking it asks the browser for **one optional host permission**, `https://<host>/*`, where `<host>` is the parsed `GenericEmbed.host`. The `declarativeNetRequestWithHostAccess` API permission is requested in the same `permissions.request` call in Chromium (Firefox: §4). There is **no new install-time permission** and no `<all_urls>`. `https://*/*` is already in `optional_host_permissions` (ADR 0005), so a single host is a subset that the browser can grant on its own.
- Once the host is granted, later unlocks of the same host skip the prompt, and the viewer can revoke the host from the browser's extension settings. A revoked host loses its rules because DNR stops matching without host access.
- **Amendment (OME-1042, 2026-10-14):** the opt-in "video found" indicator holds `https://*/*`, which contains every host, so a grant alone no longer proves consent. While `https://*/*` is held, an unlock without the consent page also needs the host in the consent page's stored approvals (`storage.local` `unlockHosts`, written only on Allow; a host is dropped when its own grant is revoked). With the toggle off this is the grant alone, as above.
- The unlock is per viewer. Every viewer who wants to watch that host needs the extension, as with TwoSeven.

### 2. Framing headers: DNR session rules, scoped to one host in one tab

On unlock, the extension adds `declarativeNetRequest` **session** rules (no blocking `webRequest`, no static rulesets):

```
condition: {
  resourceTypes:    ["sub_frame"],
  initiatorDomains: [<our server's host>],
  requestDomains:   [<host>],
  tabIds:           [<room tab id>],
}
action: modifyHeaders, responseHeaders:
  { header: "x-frame-options",          operation: "remove" }
  { header: "content-security-policy",  operation: "remove" }   // only with the condition below
```

- **`X-Frame-Options` is removed.** It only says "don't frame me", so nothing else is lost.
- **CSP: DNR can't edit part of a header.** `remove` drops every CSP header on the response, and `set` replaces them with one value we would have to invent. An `append` can only add restrictions. So `frame-ancestors` can't be dropped on its own. We remove the whole CSP, but **only from responses whose CSP mentions `frame-ancestors`**. In Chromium that is the rule condition `responseHeaders: [{ header: "content-security-policy", values: ["*frame-ancestors*"] }]`, in a second rule. Firefox supports no `responseHeaders` condition in any version (MDN browser-compat-data), and there we do **not** strip CSP: those hosts stay blocked on that browser, and `X-Frame-Options` hosts still unlock.
- **The cost:** a framed document whose CSP we drop loses its own XSS and script-source protection while it plays in our tab. We accept that because it applies only to `sub_frame` documents (never to subresources, workers or other tabs), only to the one host the viewer unlocked, only in the room tab, and only while the frame stays inside the unchanged ADR 0024 sandbox (no popups, no top navigation, cross-origin to us). TwoSeven drops CSP on every frame of every host.
- **Lifetime:** rules are removed when the room's embed changes away from that host, when the room tab navigates off our origin, when the tab closes (`tabs.onRemoved`), and on browser restart, because session rules don't persist. Rule ids come from the tab id, so a tab has at most one set and re-unlocking replaces it.
- A redirect to another host does not match `requestDomains` and is not unlocked. A frame nested inside the embed has the embed as its initiator, not us, so it doesn't match either. Both are accepted.

### 3. Referer gates (pending board sign-off)

ADR 0024 §2b sends no `Referer`. For a host the viewer has unlocked, a third rule in the same set **sets the frame navigation's `Referer` to the embed's own origin**, `https://<host>/`:

```
condition: same as §2
action: modifyHeaders, requestHeaders: { header: "referer", operation: "set", value: "https://<host>/" }
```

- **It leaks nothing new.** The host learns only its own origin, which it already knows. It does not learn our room, our origin or the page the video was shared from. The iframe keeps `referrerpolicy="no-referrer"`, so viewers without an unlock still send nothing.
- **We do not carry the shared-from page.** Setting `Referer` to the partner page would mean storing and broadcasting that page's URL with the embed, which has a privacy cost (everyone in the room learns where the link came from). The spike shows kwik doesn't need it. Hosts that accept only their partner site stay blocked. That is an accepted loss, and a new ADR is needed to change it.
- **This is Referer spoofing:** we tell the host that it framed itself. The issue requires board sign-off for that, and it is asked for on [OME-1039](/OME/issues/OME-1039). Until it is given, the extension ships §2 without this rule, and kwik.cx keeps failing.

### 4. Permissions and stores

- **Chromium:** `optional_permissions` gains `declarativeNetRequestWithHostAccess`, and it is requested together with the host. The Chromium source sets `kFlagCannotBeOptional` only on plain `declarativeNetRequest`.
- **Firefox (deviation, with the reason):** Firefox does not accept `declarativeNetRequestWithHostAccess` as an optional permission (its schema defines it only as `PermissionNoPrompt`), so it goes in `permissions`. This is the one new install-time entry. It shows no prompt and no warning, it doesn't trigger re-consent on update, and on its own it does nothing: a rule only acts where the viewer has granted host access. There is still no new install-time **host** permission.
- `optional_host_permissions` and `host_permissions` are unchanged on both browsers. The store-manifest guard (`apps/extension/store/manifest.ts`) is updated to allow exactly these entries per browser. Today it allows no `optional_permissions`.
- Firefox has no `responseHeaders` rule condition, so it gets no CSP rule (§2).
- `declarativeNetRequestWithHostAccess`, not `declarativeNetRequest`, because it acts only where we hold host access (the unlocked host and our own origin) and carries no "block content on any page" warning.
- **No cookies permission and no cookie forwarding.** The frame keeps whatever cookies the browser gives it under the sandbox's `allow-same-origin`.
- The CWS and AMO listings and `apps/extension/STORE.md` disclose this: "Unlock with extension" lets a video host you choose play inside a room. For that host only, in that room tab only, the extension removes the host's anti-framing headers and tells the host that it framed itself. It does this only after you approve that host, and you can revoke it in the browser's extension settings. The CWS single-purpose and permission justifications and the AMO reviewer notes say the same. `data_collection_permissions` don't change: nothing new is sent to us.

### 5. Site ↔ extension bridge

The smallest bridge is **a content script that matches only our origin**. It works the same in Chromium and Firefox. `externally_connectable` is Chromium-only and would need a Firefox fallback anyway.

- Its `matches` is the default server origin, which is already the extension's only install-time host, so there is no new warning. Self-hosted servers granted from the options page get the script through `scripting.registerContentScripts` when the grant is made.
- Messages go over `window.postMessage` with `targetOrigin` set to our origin. Each side checks `event.source === window` and `event.origin`, then parses with Valibot. The schemas live in `packages/shared` (contract issue): page → extension `unlock { host }` and `relock {}`; extension → page `present { version }` and `unlock-result { host, outcome: "unlocked" | "denied" | "unsupported" }`. `host` must pass the generic host rules (ADR 0024 §1). The content script forwards only parsed messages to the background with `runtime.sendMessage`, and the background re-checks the sender's tab URL against our origin.
- **The permission prompt needs a user gesture in an extension context.** Both browsers require a gesture for `permissions.request`, and neither documents that a page click carries one through `runtime.onMessage`. So when the host isn't granted yet, the background opens a small extension page, "Let `<host>` play in your omega-share room?". Its Allow button calls `permissions.request`, and the background then installs the rules for the tab that asked. When the host is already granted, the rules are installed directly and no prompt appears.
- The web creates or reloads the iframe only after it gets `unlocked`, so the first navigation already matches the rules.

### 6. Performance

- Rooms that don't use it pay nothing. The web registers one `message` listener, and the card gains one button that appears only after `present`. There are no new requests, and no new code runs in the frame loop.
- The content script is a few hundred bytes. It runs only on our origin, and only for viewers who have the extension. It posts `present` once and idles.
- The popup is untouched. The room and popup budgets in `docs/perf-budgets.md` don't move.

## Consequences

- ADR 0024's accepted loss narrows. Hosts that refuse framing by `X-Frame-Options` play for viewers who unlock them. So do hosts that refuse by `frame-ancestors`, in Chromium. kwik-style self-allowlisting Referer gates play too, once §3 is signed off. Hosts that accept only their partner site's `Referer`, and DRM-only hosts, still fail.
- The extension gains one optional API permission, a content script on our origin, a consent page and a background module that owns the session rules. The web gains one button, one hint line and the bridge listener. `packages/shared` gains the bridge schemas.
- Viewers who unlock a host run that host's page in our tab without its own CSP (Chromium, `frame-ancestors` hosts only). This is the cost recorded in §2.
- Work: shared contract (bridge schemas) first. Then web (card button and hint) and extension (permission, rules, bridge, consent page, store copy), in parallel. The extension's Referer rule follows the board's sign-off.
