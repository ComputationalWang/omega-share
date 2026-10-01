# ADR 0025 — Trusted Types enforced, with YouTube's loader policy as the one exception

**Status:** accepted (2026-10-01) · CEO decision [OME-284](/OME/issues/OME-284) (option A) · server [OME-273](/OME/issues/OME-273) · amends ADR 0011 (accepted risk) · threat model `docs/research/m3-threat-model.md` §B3

**Context:** M3 sent Trusted Types report-only: `require-trusted-types-for 'script'; trusted-types omega-sdk`. Our own sinks are the three SDK `script.src` assignments, and they go through the `omega-sdk` policy (`apps/web/src/player/sdk-policy.ts`), which passes only the three SDK URLs. M4 enforces Trusted Types. The real YouTube `https://www.youtube.com/iframe_api` creates its own policy, `trustedTypes.createPolicy("youtube-widget-api", { createScriptURL: x => x })`, and assigns its player script through it. With only `omega-sdk` allowed, that policy is refused, the `script.src` assignment throws, and `YT.Player` never loads (evidence in OME-284). ADR 0011 predicted this.

**Decision:**
- The enforced `Content-Security-Policy` header (`apps/server/src/headers.ts`) ends with `require-trusted-types-for 'script'; trusted-types omega-sdk youtube-widget-api`.
- Exactly those two policy names. No `'allow-duplicates'`, no `*`, no other provider policy. `apps/server/test/boundary.test.ts` pins the full header value, so any widening fails a test.
- The `Content-Security-Policy-Report-Only` header is dropped. It carried only the TT directives, which are now enforced.
- The web `<meta>` CSP (dev only) does not carry TT. Header and meta intersect, so production gets the header's enforcement.

**Accepted risk:** the `youtube-widget-api` policy passes any URL, and the loader keeps it in a top-level `var` (`window.ttPolicy`). Any script on our page can use it to mint a `TrustedScriptURL` for any URL. Trusted Types therefore does **not** bound which scripts can be loaded. **`script-src` path scoping is the control that does** (ADR 0011: our origin, `https://www.youtube.com/iframe_api`, `https://www.youtube.com/s/player/`, and the Twitch and Vimeo loader paths). What we gain over report-only is enforcement on the HTML and script sinks (`innerHTML`, `eval`-likes, inline handlers set from strings) for the first time. That is the DOM-XSS protection.

**Rule:** do not loosen `script-src` (a whole host, a wider path, `'unsafe-inline'`, `'unsafe-eval'`, `https:`) without revisiting this ADR. Once `script-src` is wider, the pass-through policy lets any page script load code from the wider source.

**Consequences:**
- Regular e2e and `e2e:real` serve the site through Vite dev, which sends only the meta CSP, so they never see the TT header. Only the `e2e-tunnel` lane (built site through the server, fake SDKs) and real-tunnel runs see it. The real-provider check for this ADR (YouTube, Twitch, Vimeo, zero enforced TT violations) must run against the server-served build: real-tunnel, or server + `STATIC_DIR`.
- A new provider SDK that creates its own policy needs a new ADR to add its name.
