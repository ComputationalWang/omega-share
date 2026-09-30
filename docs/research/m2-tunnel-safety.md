# M2 research: tunnel safety — ngrok, single origin, Origin/Host, proxy-aware rate limits, share endpoint

[OME-119](/OME/issues/OME-119) · 2026-09-30 · Lead Engineer · research only. Nothing here changes code or `packages/shared`. The contract/ADR issue ([OME-123](/OME/issues/OME-123)) turns §9 into ADR 0014 and the contract change. The engineering issues ([OME-128](/OME/issues/OME-128) server+site, [OME-130](/OME/issues/OME-130) extension, [OME-132](/OME/issues/OME-132) QA proxy e2e, [OME-133](/OME/issues/OME-133) real checklist) take their acceptance criteria from §10.

M2 is the first time the app can be reached from the internet. ADR 0007 said to revisit the unauthenticated share endpoint "before a public deploy". That is now.

**Evidence labels.** **[doc]** is an official vendor or spec page, fetched 2026-09-30. **[code]** is our repo at `main@9bf386f`. **[inferred]** is reasoning that has not been verified yet. Every **[inferred]** item that matters is a line in the real-ngrok checklist (§8.3).

**Sources**
- ngrok: Terms of Service <https://ngrok.com/tos> (TOS), free plan limits <https://ngrok.com/docs/pricing-limits/free-plan-limits/> (FREE), agent CLI <https://ngrok.com/docs/agent/cli/> (CLI), agent config <https://ngrok.com/docs/agent/config/> (CFG), HTTP endpoints and headers <https://ngrok.com/docs/http/> (HTTP), Traffic Policy actions <https://ngrok.com/docs/traffic-policy/actions/> (TP): `basic-auth`, `oauth`, `add-headers`.
- Cloudflare: Quick Tunnels <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/> (TRY), HTTP headers <https://developers.cloudflare.com/fundamentals/reference/http-headers/> (CFH), cloudflared LICENSE <https://github.com/cloudflare/cloudflared/blob/master/LICENSE> (Apache-2.0).
- Chrome: `chrome.permissions` <https://developer.chrome.com/docs/extensions/reference/api/permissions> (PERM).
- Bun: HTTP server <https://bun.sh/docs/api/http> (BUN).
- Vite: server options <https://vite.dev/config/server-options> (VITE), for its `allowedHosts` DNS-rebinding guard.
- Twitch embed <https://dev.twitch.tv/docs/embed/video-and-clips/>, YouTube RMF <https://developers.google.com/youtube/terms/required-minimum-functionality>, and `docs/research/m2-twitch-vimeo-sync.md` §2 (OME-118).

## TL;DR: the recommendation

| Question | Recommendation |
|---|---|
| ngrok | An **operator tool**, never a repo dependency. It's a proprietary binary under a revocable license [TOS]. The board provides an account. Its authtoken is a Paperclip secret, injected as `NGROK_AUTHTOKEN` [CLI]. Use the free plan's **one fixed dev domain** (`*.ngrok-free.app`) [FREE], started with `ngrok http 127.0.0.1:8787 --url https://<dev-domain>`. Fallback: `cloudflared tunnel --url http://127.0.0.1:8787` (Apache-2.0, no account, random host) [TRY]. |
| Topology | **One origin.** `apps/server` serves the built site (`apps/web/dist`) with `hono/bun`'s `serveStatic`, so no new dependency. The site defaults to `location.origin` for the API and WebSocket. The server binds to **`127.0.0.1` by default**. Bun's default is `0.0.0.0` [BUN]. Never tunnel the Vite dev server. |
| Origin / Host | A new `PUBLIC_ORIGIN` config value (for example `https://x.ngrok-free.app`) joins `SITE_ORIGIN` in the Origin allowlist, for CORS and the WebSocket upgrade. A new **`Host` allowlist** (the public host, plus `localhost`/`127.0.0.1`/`[::1]` on our port) turns any other Host away with 421. That stops DNS rebinding. |
| `X-Forwarded-*` | Trust them **only** when `TRUST_PROXY=loopback` is set **and** the socket peer is a loopback address. Then use the **rightmost** `X-Forwarded-For` entry, which is the one the tunnel appended [HTTP, CFH]. Ignore `X-Forwarded-Host`, because ngrok passes the client's value through [HTTP]. |
| Rate limits | Key limits by `clientKey(req)` = that rightmost XFF address, reduced to its /64 for IPv6 (the existing `addressKey`). On top of that, add **global ceilings** that no key choice can dodge: total sockets, total shares per second. Also lower the per-client socket cap from 50 to 10 in tunnel mode. |
| Share endpoint | **Member-bound share token** (contract change): `snapshot.shareToken` (128-bit random, valid while that member is joined). `POST /rooms/:id/share` requires `Authorization: Bearer <token>`, **always**, not only in tunnel mode. `embed-changed.by` becomes the sharing member. The extension reads the token from the open room tab, using permissions it already has (§5.3). |
| Gate the room? | The share token stops drive-by shares, but **anyone who knows the URL can still join, chat and control playback**, and the free dev domain never changes. Recommendation: in M2, **gate the whole tunnel at the ngrok edge with the `oauth` action and an email allowlist** while M3 moderation doesn't exist. That's a **board decision** (§11, B3). The app-level controls ship either way, and they are what CI tests. |
| Extension | Keep the existing design (ADR 0005): the static host permission covers only `http://localhost:8787`, the tunnel origin is requested at runtime through `optional_host_permissions: ["https://*/*"]` from the options page (a user gesture) [PERM], and `parseServerBaseUrl` already requires `https:` off-loopback [code]. The popup adds a **server-status line**: no permission / unreachable / tunnel offline / sign-in needed / open the room tab. |
| Providers | Twitch `parent` = `location.hostname`, which becomes the tunnel host with no config. YouTube `origin` and `Referer` follow `location.origin` [code: `apps/web/src/tv.ts:29`]. Vimeo videos limited to other domains will refuse, which goes through the existing notice path. Room ids are **not** secret in M2, because the Twitch SDK sends the full page URL as `referrer`. |
| Tests | Add a local **TLS reverse-proxy fixture** (`omega.test`, committed self-signed test cert, appends XFF, forwards WebSocket) plus Chromium `--host-resolver-rules`. CI never needs ngrok. A short real-ngrok checklist goes in [OME-133](/OME/issues/OME-133). |

## 1. ngrok itself

### 1.1 Licensing: operator tool, not a dependency
- The agent is licensed "non-exclusive, non-transferable, non-sublicensable, revocable". Reverse engineering and derivative works are prohibited, and redistribution is limited [TOS]. It is not open source.
- **Rule:** nothing in the repo installs, vendors, downloads or `import`s ngrok. That means no npm `ngrok`/`@ngrok/ngrok` package, because the Node SDK wraps the same service and ToS. The repo ships only **docs** (`docs/ops/tunnel.md`, written in OME-128) and an optional wrapper script. The script calls an `ngrok` that is already on `PATH` and exits with a clear message if there isn't one. That keeps the AGPL-3.0-only codebase clean: an operator running a separate program over the network is not linking.
- cloudflared is Apache-2.0 [cloudflared LICENSE], which is also fine as an operator tool, under the same "not a dependency" rule.

### 1.2 Account, authtoken, where it lives
- **The board provides:** an ngrok account (free is enough to start; see §11 B1/B2), and the authtoken from the dashboard.
- **Storage:** a Paperclip company secret, e.g. `ngrok_authtoken`, bound as env `NGROK_AUTHTOKEN` for the agent/operator that runs the tunnel. The agent reads that variable directly [CLI], so there is **no** `ngrok config add-authtoken` step. That step would write the token into `~/.config/ngrok/ngrok.yml` [CFG], a credential file outside Paperclip's control.
- **Never:** in the repo, in `.env` files committed or not, in issue comments, in logs, or on a command line (`--authtoken` shows up in `ps`). The wrapper script must not `set -x` or echo its environment.
- The Traffic Policy file for the edge gate (§4.3) holds the email allowlist, which is personal data, or the basic-auth credentials, which are a secret. It is **generated at runtime** from Paperclip secrets into `$PAPERCLIP_RUN_SCRATCH_DIR` (or `$XDG_RUNTIME_DIR`) and never committed. The repo commits only a template with placeholders.

### 1.3 Free tier limits, and what they mean for us [FREE]
| Limit | Free | Our use |
|---|---|---|
| Data | 1 GB / month | Only the site bundle and WebSocket frames go through the tunnel. **Video streams go straight from the provider to each viewer.** 25 members × a ~250 KB first load is about 6 MB per session. Well inside. |
| HTTP requests | 20 000 / month; 4 000 / min | About 10 requests per page load, and one upgrade per socket. WebSocket frames are not HTTP requests [inferred; checklist N6]. Fine for sessions; **a hostile client could burn the monthly quota**, which is one more reason for the edge gate. |
| Endpoints / agents | 3 online endpoints, 3 agents | We need 1. |
| Domain | **One auto-assigned dev domain** (`<name>.ngrok-free.app`). Custom and reserved domains are paid. | A **fixed** hostname, not random per run. Good: the extension and Twitch `parent` are set once. Bad: the URL is effectively permanent, so being hard to guess protects nothing. |
| Traffic Policy | 5 rules per policy | Enough for the gate plus header hygiene (§4.3). Which actions (`oauth`, `basic-auth`) the free plan allows **is not stated** on the page → checklist N4, and a board question if they're paid. |

### 1.4 The browser interstitial
- The free tier shows a warning page for "HTML browser traffic". It "does not impact users serving APIs or accessing ngrok endpoints programmatically". It is skipped when a request has an `ngrok-skip-browser-warning` header (any value) or a non-standard `User-Agent`. A paid plan removes it [FREE]. The `add-headers` action **can't** be used to bypass it [TP add-headers].
- **Site:** the visitor's first top-level navigation shows the warning page once. After "Visit Site" the site loads normally [inferred: ngrok remembers the choice in a cookie; checklist N2]. We can't add a header to a navigation, so we accept this. `docs/ops/tunnel.md` tells invitees to expect it. Bundle assets are JS/CSS/PNG, not HTML navigations.
- **WebSocket:** an upgrade is not HTML traffic. We expect it to be unaffected, and the page has already passed the warning anyway [inferred; checklist N3].
- **Extension:** popup `fetch`es are programmatic and JSON. They should pass, but the popup's `User-Agent` is Chrome's. **Recommendation:** the extension sends `ngrok-skip-browser-warning: 1` on every server request. It's harmless elsewhere, and the server's CORS `allowHeaders` adds it so the site could use it too [inferred; checklist N3].
- **Embeds:** the YouTube, Twitch and Vimeo iframes are on the providers' hosts, not ours, so the interstitial doesn't apply to them.

### 1.5 Fallback: Cloudflare quick tunnel
`cloudflared tunnel --url http://127.0.0.1:8787`. No account [TRY, inferred from the page]. You get a **random** `*.trycloudflare.com` host each run, so the extension and anything pinned to the host must be updated every session. Limits: 200 concurrent requests (429 beyond), no SSE [TRY]. We don't use SSE. It appends `X-Forwarded-For` and sets `CF-Connecting-IP` [CFH], so the rightmost-XFF rule (§3.3) works unchanged. There is no edge auth without a Cloudflare account (Access), so it is **only a fallback for an ungated session**. Documented in `docs/ops/tunnel.md`, never automated.

## 2. Topology: one origin

### 2.1 Today [code]
- The site is served by Vite on 5173 (dev) or `vite preview` (e2e). The server is on 8787.
- The site finds the server at `VITE_SERVER_URL ?? ${location.protocol}//${location.hostname}:8787` (`apps/web/src/main.ts:29`).
- `apps/server/src/index.ts` only passes `hostname` when `HOST` is set, so **the server listens on `0.0.0.0` today** (Bun's default [BUN]). Anyone on the LAN can reach it. That is a bug to fix regardless of M2.

A tunnel exposes one local port. Options:
1. **Server serves the built site** (recommended).
2. A path proxy in front of both (Caddy or nginx, or ngrok's own routing). That's a third process, a second config language, and Vite dev exposed to the internet. Vite's `allowedHosts` guard would 403 the tunnel host anyway unless it's turned off, and Vite's own docs warn that turning it off lets "any website … download your source code" [VITE].

### 2.2 Recommendation
- `startServer({ …, staticDir })`: when `staticDir` (env `STATIC_DIR`, default unset) is set, Hono serves it with `serveStatic` from `hono/bun`. That's already a dependency (hono 4.13), so no bundle or licence change.
  - `/`, `/r/:room` and any non-API path without a file extension → `index.html` (the SPA fallback).
  - `/assets/*` (Vite-hashed) → `Cache-Control: public, max-age=31536000, immutable`. `index.html` → `no-cache`.
  - API routes are unchanged: `GET /rooms`, `POST /rooms/:id/share`, `GET /rooms/:id/ws`. The site's room route is `/r/:room`, so there's no collision.
  - The readiness probe moves from `GET /` to **`GET /healthz`**, because `/` becomes the site. The Playwright `webServer.url` and `e2e/support/apps.ts` change with it. QA's root-script claim, see Coordination.
- **Security headers on every response** (the server's job, since a `<meta>` CSP can't express them): `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Content-Security-Policy: frame-ancestors 'none'`. Header and meta CSPs **intersect**, so this header CSP carries only `frame-ancestors` and the `<meta>` in `index.html` stays the single source for everything else. One place to update when OME-124 adds Twitch and Vimeo `frame-src`.
- **Site base URL:** the default becomes `location.origin`, same origin. `VITE_SERVER_URL` stays for dev and e2e (`bun run dev` sets it to `http://localhost:8787`). `wsUrl()` already derives `ws:`/`wss:` from the base URL [code: `apps/web/src/route.ts:11`], so `https://…ngrok-free.app` → `wss://…/rooms/lobby/ws`. Mixed content is impossible by construction.
- **Bind loopback:** `HOST` defaults to `127.0.0.1`. The tunnel agent is pointed at `127.0.0.1:8787` explicitly. ngrok's default upstream is `localhost` [CLI], and `localhost` may resolve to `::1` first, so a v4-only listener would refuse it [inferred; checklist N1].
- One process, one port, one WebSocket per client, Bun pub/sub per room: all as today. The perf budgets are unaffected. Static files are served lazily through `Bun.file` [BUN], and the frame path in the browser doesn't change.

## 3. Boundary checks

### 3.1 Origin (CORS + WebSocket upgrade)
- Today `isAllowedOrigin = origin === SITE_ORIGIN || chrome-extension://<32 a-p>` and a missing `Origin` is allowed (non-browser clients) [code: `server.ts:69`].
- **Change:** `allowedOrigins = {SITE_ORIGIN, PUBLIC_ORIGIN}`, both parsed at startup as bare origins with the same rules as the extension's `parseServerBaseUrl`: `https:` unless loopback, and no path. A bad value fails startup. The extension regex stays, and **optionally** narrows to `EXTENSION_IDS` (comma-separated) once we have a published id.
- A missing `Origin` stays allowed. It isn't a CSRF vector, and a non-browser client can forge any `Origin` anyway. The Origin check is only there to stop *a hostile page in a visitor's browser* (CSRF / cross-site WebSocket hijacking). Real protection against scripted abuse is the share token (§4), the limits (§3.4) and the edge gate.
- CORS `allowHeaders`: add `authorization` (share token) and `ngrok-skip-browser-warning`.

### 3.2 Host (DNS rebinding)
- Threat: a hostile page the operator visits rebinds `evil.example` to `127.0.0.1`. Its scripts then talk to our loopback server as **same-origin** `http://evil.example:8787` and can read the responses. Today the Origin check happens to refuse that origin on `/share` and the upgrade, but `GET /rooms` (and any future GET) has no Origin gate, and same-origin requests may omit `Origin`. The robust fix is the one Vite ships for the same reason [VITE]: refuse unknown `Host` values.
- **Change:** `allowedHosts = {PUBLIC_ORIGIN's host, localhost:<port>, 127.0.0.1:<port>, [::1]:<port>}`, plus `SITE_ORIGIN`'s host when that's also served here. Any request, including a WebSocket upgrade, whose `Host` isn't in the set → **421 Misdirected Request**, plain text, before routing. Compare lowercase, exact, including the port.
- What ngrok sends as `Host`: the public hostname unless a policy rewrites it [HTTP, inferred from "Host rewrite is done with `add-headers`"; checklist N5]. Either way it's in the set.

### 3.3 What the server trusts from `X-Forwarded-*`
- ngrok **appends** the client address to `X-Forwarded-For` and `X-Forwarded-Proto`, so the *last* value is ngrok's. It passes a client-supplied `X-Forwarded-Host` through [HTTP]. Cloudflare also appends to XFF [CFH].
- **Rule (`clientKey(req)`):**
  1. `peer = server.requestIP(req)?.address` [BUN].
  2. If `TRUST_PROXY !== "loopback"`, or `peer` is not a loopback address (`127.0.0.0/8`, `::1`, `::ffff:127.x`) → key = `addressKey(peer)`. **XFF is ignored.**
  3. Else take the **rightmost** comma-separated entry of the **last** `X-Forwarded-For` header, trimmed. If it parses as an IPv4/IPv6 literal → key = `addressKey(it)`. Else (missing or garbage) → key = `"proxy:unknown"`, one shared tight bucket, and log once.
- A client can prepend anything to XFF, but it can't control the entry the tunnel appends, so the key can't be spoofed. Anything reaching the loopback listener *without* the tunnel is either the operator or a local process. The `Host` check plus the loopback bind cover that.
- `X-Forwarded-Proto` and `X-Forwarded-Host` are **not used**. The public origin comes from config (`PUBLIC_ORIGIN`), never from headers. Nothing builds absolute URLs from requests.
- `TRUST_PROXY=loopback` is set only by the tunnel wrapper. `PUBLIC_ORIGIN` set without it logs a startup warning ("all clients will share one rate-limit bucket").

### 3.4 Rate limits behind the tunnel
Today every limit keyed by address becomes **one global bucket** behind the tunnel: `shareLimiter` and `connectionsPerIp` (cap 50) [code]. Fifty sockets from one attacker then lock out *everyone*. Changes:
- **Key:** `clientKey(req)` (§3.3) everywhere `ipOf(req)` is used today.
- **Per client:** the socket cap drops to **10** when `TRUST_PROXY` is set. A real person has one tab, maybe two, plus reconnects. Keep 50 locally, because the e2e load test opens 25 members from one address.
- **Per member:** shares are also limited by member id (burst 5, then 1 per 3 s). The per-socket WebSocket buckets (20/10 s, control 4/s) already exist and don't depend on the address.
- **Global ceilings**, whatever the key: total open sockets ≤ **200** (8 rooms' worth of `MAX_ROOM_MEMBERS` = 25, ADR 0006) → 503. Total shares ≤ burst 20, 2/s → 429. These bound the damage from an attacker who controls many addresses (IPv6 /64s, botnets) and protect the ngrok monthly quota.
- **Edge (optional, if free):** an ngrok `rate-limit` policy action keyed by `conn.client_ip` [TP] is defense in depth only. The app-level limits are the tested ones.
- The existing primitives stay allocation-free per call: `TokenBucket`, and `KeyedLimiter` with LRU and `maxKeys` [code: `rate-limit.ts`].

## 4. The share endpoint (ADR 0007 revisit) and gating

### 4.1 What changes when public
ADR 0007 bet on "only a canonical YouTube embed can be set" and "the flow is local". Public, with a fixed URL:
- Anyone on the internet (curl, no Origin) can switch the lobby's video every 3 s from each address.
- `by: null` hides who did it, so members can't tell a prank from the extension.

### 4.2 Recommendation: a member-bound share token (contract change, OME-123)
- **Wire:** `snapshot` gains `shareToken: string` (only in the recipient's own snapshot, never broadcast). It is 22 base64url characters, 128 bits from `crypto.getRandomValues`. `ShareErrorCode` gains `unauthorized` (HTTP 401). `ShareRequest` is unchanged; the token travels in `Authorization: Bearer <token>`, so it isn't logged with bodies and isn't a CORS-simple request.
- **Server:** `Map<token, {roomId, memberId}>`. A token is issued at `join` and **deleted** on `leave` or socket close. `POST /rooms/:id/share` requires a live token for that room. The broadcast becomes `embed-changed { by: memberId }`, so members see who shared. `by: null` stays in the schema for server-initiated changes.
- **Always on**, not only in tunnel mode: one code path, one set of tests. The e2e specs that POST `/share` directly (`e2e/acceptance.e2e.ts:14`, `e2e/sync-smoke.e2e.ts:12`) must join first and use the token. QA owns that change in OME-132, which is blocked by the contract.
- **Site:** after `snapshot`, the site writes `sessionStorage["omega.share"] = JSON.stringify({ roomId, token })` and removes it on leave, `room-full` or socket close. The token is scoped to that tab's session and never goes in the URL. That matters because Twitch receives the page URL (§6).
- Why this and not a "pairing code" the user pastes: the product flow is "I'm sitting in the room; I share what I'm watching in another tab". The room tab is already open, and the extension can read it with no new permission (§5.3).

### 4.3 Should the whole room be gated in M2? **Yes, at the edge (board decision B3)**
- The share token only stops *non-members*. A member can already control playback and chat, and **anyone who knows the fixed URL can become a member**. There is no moderation, kick or private room until M3. So ungated M2 means "the internet can join our room while the tunnel is up".
- **Recommended gate: ngrok `oauth` action (managed Google or GitHub app) + email allowlist**, as in [TP oauth]: `!(actions.ngrok.oauth.identity.email in [...])` → deny. It covers the site, the API and WebSocket upgrades on one origin (they share the session cookie). The email list is kept in Paperclip, never in the repo.
- **Second choice:** `basic-auth` (up to 10 user:password pairs, 8–128-char passwords) [TP basic-auth]. Simpler, but it shows the browser's auth dialog, and the extension's `fetch` would need the credentials.
- **Extension with a gate:** the popup's `fetch` must send `credentials: "include"` so the ngrok session cookie goes along. It works only once the user has signed in to the room in the same browser profile [inferred: Chrome treats requests from an extension to a host it has permission for as same-site for cookies; checklist N7]. A 302 to the login page, or an HTML 401 → popup state "Sign in to the room in a tab first" (§5.4). Because sharing already requires an open room tab, that's the same precondition.
- **Whether `oauth` / `basic-auth` are on the free plan isn't stated** [FREE]. Checklist N4. If paid, cost is the board's call (B2).
- **If the board declines gating:** M2 runs as "public while hosted". The operator starts the tunnel only for a session and stops it after, and the board accepts in writing that URL holders can join, chat and control until M3. The app-level controls in §3–§4.2 ship either way.
- **Not recommended for M2:** an app-level invite secret in the room URL. It's a second contract change, it would leak through the Twitch `referrer` (§6), and it's really M3's private-rooms feature.

## 5. Extension

### 5.1 Permissions: keep runtime, not static
- Keep ADR 0005: the static `host_permissions` hold only the default `http://localhost:8787/*`. The tunnel origin is granted at runtime from `optional_host_permissions: ["http://*/*", "https://*/*"]`. `chrome.permissions.request` must run inside a user gesture, and `contains()` checks whether it was granted [PERM]. The options page already does this on Save [code: `entrypoints/options/main.ts:29`].
- A static `https://*.ngrok-free.app/*` would grant us every ngrok user's site. It also ties the manifest to one vendor (the cloudflared fallback is a different host) and gets a broad-host review at the Web Store. **Rejected.**
- On Save of a new origin, the extension **removes** the permission for the previous non-default origin (`permissions.remove`). Only one server origin is ever granted.

### 5.2 URL validation
`parseServerBaseUrl` already does the right thing [code: `settings.ts`]: bare origin, `https:` off-loopback, no credentials, path, query or fragment. Additions:
- Reject IP-literal `https:` origins other than loopback. A tunnel always has a name, and this refuses "type your LAN IP" mistakes. Minor; optional.
- Keep refusing credentials in the URL, even with basic-auth at the edge.

### 5.3 Getting the share token
On popup open, after the scan:
1. `chrome.tabs.query({ url: "<serverOrigin>/r/*" })`. URL filtering works because the extension has host permission for that origin. No `tabs` permission.
2. For the first match, `chrome.scripting.executeScript({ target: { tabId }, func: () => sessionStorage.getItem("omega.share") })`. That uses the existing `scripting` permission plus host permission. The injected function **only reads**; the result is `unknown`, and Valibot-parses to `{ roomId, token }`.
3. The room dropdown pre-selects that tab's room. `shareEmbed` sends `Authorization: Bearer`. No token → the Share button is disabled with "Open the room in a tab to share into it."

This is a one-shot injection when the popup opens, like the embed scan. No content script runs until the popup is opened, and there is no persistent background worker (product spec).

### 5.4 Popup states while the tunnel is down or gated
The popup runs one `GET /rooms` probe, which it already does for the room list [code: `rooms.ts`], and maps the outcome to a status line and the Share button's state:

| Probe outcome | Status line | Share |
|---|---|---|
| `permissions.contains` false | "Allow access to `<origin>` in Options" + button | off |
| `fetch` throws (DNS, TLS, refused) | "Can't reach `<origin>`. Is the tunnel running?" | off |
| Non-2xx, or 2xx that isn't a valid `RoomListResponse` (ngrok's offline error page is HTML [inferred; checklist N8]) | "The server at `<origin>` isn't answering. The tunnel may be offline." | off |
| Redirected to the OAuth login, or 401 | "Sign in to the room in a browser tab first." | off |
| OK, no room tab / token | "Open the room in a tab to share into it." | off |
| OK + token | (hidden) | on |

`loadRooms` returns a discriminated outcome instead of silently falling back to `FALLBACK_ROOMS`. It still never throws.

## 6. Providers and the page origin
- **Twitch:** `parent` must be every hostname that embeds the player [Twitch doc]. We pass `parent: [location.hostname]` and the SDK derives the same value (OME-118 §2.1), so the tunnel host works with no config, and the fixed dev domain doesn't even change between runs. The Twitch iframe `src` must be HTTPS, which the tunnel provides. Local `http://localhost` is OME-118 checklist T2.
- **YouTube:** `origin` playerVar = `location.origin` [code: `tv.ts:29,42`], and the embed must send a `Referer` with `strict-origin-when-cross-origin` [YouTube RMF]. Our meta already sets that, and §2.2's header repeats it. Both follow the tunnel origin automatically.
- **Vimeo:** videos with domain-level privacy that doesn't include the tunnel host will refuse → the OME-110 notice path (OME-118 §2.2, checklist V2).
- **Privacy:** the Twitch SDK puts `referrer=document.location.href` in its iframe URL (OME-118 §2.1). The full room URL goes to Twitch, so **nothing secret may be in the page URL**. That's why the share token lives in `sessionStorage` (§4.2) and why an invite-in-URL gate is rejected (§4.3).
- **CSP:** `connect-src 'self' ws: wss:` stays in the meta while dev is cross-origin. The tunnel is same-origin, so it's covered. `frame-src` changes only with providers (OME-124), not with the tunnel.

## 7. Threat table (OME-132 covers every row with a test)

| # | Threat | Control | Test |
|---|---|---|---|
| T-01 | Drive-by share from curl, no token | Share token required → 401 `unauthorized` | proxy e2e + server unit |
| T-02 | Share with the token of a member who left | Token deleted on leave or close → 401 | server unit |
| T-03 | Token for room A used on room B | Token bound to room → 401 | server unit |
| T-04 | Hostile page POSTs a share from a visitor's browser | Origin allowlist → 403; no token readable cross-origin | proxy e2e (`evil.test` page) |
| T-05 | Cross-site WebSocket hijack | Upgrade Origin allowlist → 403 | proxy e2e |
| T-06 | DNS rebinding to the loopback server | `Host` allowlist → 421 | server unit + proxy e2e (`Host: evil.test`) |
| T-07 | Spoofed `X-Forwarded-For` to dodge a limit | Rightmost entry only, only from a loopback peer with `TRUST_PROXY` | server unit (prepended XFF) + proxy e2e |
| T-08 | XFF sent directly, bypassing the tunnel | Ignored unless the peer is loopback and `TRUST_PROXY` is set | server unit |
| T-09 | One client opens many sockets and locks everyone out | Per-client cap 10 (tunnel), global cap 200 → 429/503 | proxy e2e (two synthetic clients: one capped, the other still joins) |
| T-10 | Many-address share flood | Per-member + global share buckets → 429 | server unit |
| T-11 | Server reachable from the LAN | Default bind `127.0.0.1` | server unit (`server.hostname`) |
| T-12 | Mixed content / wrong scheme behind TLS | Same-origin base URL; `wss:` derived from `https:` | proxy e2e (room joins over `wss://omega.test`) |
| T-13 | Framing the site (clickjacking) | `frame-ancestors 'none'` header | proxy e2e (header present) |
| T-14 | Authtoken leak | Paperclip secret via env only; wrapper doesn't echo it | review checklist (not automatable) |

## 8. Test strategy

### 8.1 Unit (`bun test`, OME-128)
`clientKey` (all branches of §3.3), the Host check, origin config parsing, the token lifecycle, per-member and global buckets, the default bind, `/healthz`, static serving with the SPA fallback and cache headers.

### 8.2 Local reverse-proxy fixture (OME-132, CI, no ngrok)
- `e2e/fixtures/tunnel-proxy.ts`: a `Bun.serve` with **TLS**. It uses a committed, test-only self-signed certificate for `omega.test` and `evil.test` (`e2e/fixtures/tls/`, clearly named `TEST ONLY`, valid 10 years, no secret value).
  - It forwards HTTP and WebSocket to the server on `127.0.0.1:<OMEGA_SERVER_PORT>`.
  - It **keeps** `Host`, as ngrok does.
  - It **appends** to `X-Forwarded-For`, as ngrok does. The appended address is synthetic per client: the proxy reads a test-only `x-fixture-client: <ip>` header, **strips it**, and appends that ip. So one Playwright run can play many clients.
  - It sets `X-Forwarded-Proto: https`.
- It also serves `https://evil.test/` → a page that tries T-04 and T-05.
- Server under test: `PUBLIC_ORIGIN=https://omega.test TRUST_PROXY=loopback STATIC_DIR=apps/web/dist`.
- Chromium: `--host-resolver-rules="MAP omega.test 127.0.0.1:<proxyPort>, MAP evil.test 127.0.0.1:<proxyPort>"` and `ignoreHTTPSErrors: true` [inferred: Chromium resolver-rule syntax with a port; if it fails, the fixture listens on 443 inside the test namespace, or uses `--unsafely-treat-insecure-origin-as-secure` over http]. The page then has a real `https://omega.test` Origin, a secure context, and Twitch `parent=omega.test`.
- Ports: fixture default 4430, and QA2's alternate lane 4440 (Coordination: QA lanes).
- It covers T-01…T-13, and the extension popup states in §5.4 (proxy down → "Can't reach"; proxy returning an HTML 404 → "tunnel may be offline").

### 8.3 Manual real-ngrok checklist (OME-133, `bun run e2e:real` companion; operator runs it with the board's token)
- **N1.** `ngrok http 127.0.0.1:8787 --url https://<dev-domain>` reaches the server bound to 127.0.0.1. Record whether plain `ngrok http 8787` (upstream `localhost`) works too.
- **N2.** First visit shows the interstitial exactly once. After "Visit Site", reload and `/r/lobby` load without it. Record the cookie name and lifetime.
- **N3.** WebSocket joins and relays after the interstitial. The extension popup's `GET /rooms` and `POST /share` pass with and without `ngrok-skip-browser-warning`. Record which.
- **N4.** Which Traffic Policy actions the free plan accepts: `oauth`, `basic-auth`, `rate-limit`, `add-headers`/`remove-headers`. Record the errors for refused ones.
- **N5.** What `Host`, `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host` arrive at the server (log them once in a debug build), including with a client-supplied `X-Forwarded-For: 1.2.3.4`. Confirm the rightmost entry is the real client.
- **N6.** A session with 3 real browsers for 15 minutes. Record the ngrok dashboard's request count and data. Confirm that WebSocket frames don't count as HTTP requests.
- **N7.** With the OAuth gate on (if B3 = yes): signed-in browser → site, WebSocket and extension share all work; the extension in a profile that isn't signed in → "Sign in…" state; a non-allowlisted email → denied.
- **N8.** Agent stopped: what the tunnel URL returns (status, content type, any `ngrok-error-code` header). The popup shows "tunnel may be offline".
- **N9.** Twitch live + VOD and Vimeo play with `parent` = the dev domain (OME-118 T1/V2). YouTube plays with `origin` = the dev domain.
- **N10.** From another machine on the LAN, `http://<operator-LAN-IP>:8787/healthz` is refused.
- **N11.** Fallback: `cloudflared tunnel --url http://127.0.0.1:8787` → site + WebSocket work with `PUBLIC_ORIGIN` set to the printed host. Record `CF-Connecting-IP` vs the rightmost XFF.

## 9. Recommended ADR (OME-123 writes it as ADR 0014)

> **ADR 0014 — Public tunnel: single origin, proxy-aware boundary, member-bound share token** (supersedes ADR 0007)
>
> **Decision:**
> 1. The public deploy for M2 is an operator-run tunnel (ngrok primary, cloudflared fallback) in front of **one** `apps/server` process that serves the built site and the API on one origin. The tunnel agent is never a repo dependency, and its authtoken is a Paperclip secret injected as `NGROK_AUTHTOKEN`.
> 2. The server binds `127.0.0.1` by default. Config: `PUBLIC_ORIGIN`, `SITE_ORIGIN`, `TRUST_PROXY=loopback|off` (default off), `STATIC_DIR`, optional `EXTENSION_IDS`. It is validated at startup.
> 3. Requests are refused unless `Host` ∈ the allowlist (421) and, when present, `Origin` ∈ {site, public, extension} (403). Proxy headers are trusted only from a loopback peer with `TRUST_PROXY=loopback`, and only the rightmost `X-Forwarded-For` entry. `X-Forwarded-Host`/`-Proto` are never used.
> 4. Rate limits key on that client address and are bounded by global ceilings (200 sockets, 20/2 s shares). Per-client socket cap 10 behind the proxy.
> 5. `POST /rooms/:id/share` requires `Authorization: Bearer <shareToken>`. The token comes from the member's own `snapshot` and lives until they leave. `embed-changed.by` names the member. The extension reads the token from an open room tab.
> 6. Nothing secret goes in page URLs (the Twitch SDK forwards `location.href`).
> 7. Whole-room gating for M2 is at the tunnel edge (`oauth` + email allowlist) **if the board approves**. Otherwise M2 is "public while hosted" until M3 moderation.
>
> **Why:** a tunnel exposes one port, makes every peer 127.0.0.1, and makes the room reachable by anyone with a URL that never changes. ADR 0007's assumptions (local-only, per-address limits) no longer hold.
>
> **Revisit when:** there's a hosted deploy without a tunnel, multiple or private rooms, or moderation (M3).

**Contract diff for OME-123 (`packages/shared`):**
- `SnapshotMessage`: `shareToken: string` (base64url, exactly 22 chars; `SHARE_TOKEN_LENGTH = 22`).
- `ShareErrorCode`: add `"unauthorized"`.
- Constants: `SHARE_TOKEN_STORAGE_KEY = "omega.share"`, and a `ShareTokenRecordSchema = { roomId: RoomIdSchema, token }` so the site writes and the extension parses the same shape.
- `embed-changed.by` stays `MemberId | null`; the doc comment changes ("null = server-initiated").
- No new client message. Contract version bump, per ADR 0003.

## 10. Acceptance criteria for the engineering issues

**[OME-123](/OME/issues/OME-123) (contract + ADR 0014)**
- ADR 0014 as in §9, ADR 0007 marked superseded, contract diff as in §9, with TDD: failing schema tests first.
- It rebases after or before [OME-122](/OME/issues/OME-122), whichever lands second. No hand-merge.

**[OME-128](/OME/issues/OME-128) (server + site tunnel mode)**, blocked by OME-123
- The server binds `127.0.0.1` by default. Config parsed and validated at startup; a bad `PUBLIC_ORIGIN` exits non-zero.
- Host allowlist (421), Origin allowlist with `PUBLIC_ORIGIN`, `clientKey` with rightmost-XFF-from-loopback-only, per-client and global limits, and share token issue/revoke/verify with `by: memberId`.
- `STATIC_DIR` serving with the SPA fallback, immutable `/assets/*`, `/healthz`, and the three security headers.
- The site defaults to `location.origin`, writes and clears `sessionStorage["omega.share"]`, and shows who shared.
- `docs/ops/tunnel.md`: the ngrok and cloudflared commands, `NGROK_AUTHTOKEN` from Paperclip, the policy template with placeholders only, the interstitial note, and "stop the tunnel after the session".
- An optional `scripts/tunnel.sh` that never echoes the environment.
- Unit tests for every T-row marked "server unit". `bun run check` green. The perf rows are unchanged.

**[OME-130](/OME/issues/OME-130) (extension)**, blocked by OME-123
- Runtime permission for the tunnel origin, and the previous non-default origin removed on change.
- The share token read from the room tab via `tabs.query` + `scripting.executeScript` (read-only, Valibot-parsed). `Authorization: Bearer`, `ngrok-skip-browser-warning: 1`, and `credentials: "include"` on server requests.
- The §5.4 status table as a pure, unit-tested function plus popup rendering. No new manifest permissions (ADR 0005 unchanged apart from a note).

**[OME-132](/OME/issues/OME-132) (QA proxy e2e)**, blocked by OME-128 and OME-130
- `e2e/fixtures/tunnel-proxy.ts` plus the test cert, as in §8.2, on alternate ports for QA2.
- Every T-01…T-13 row that says "proxy e2e" has a test.
- The existing direct-`/share` specs join and use a token.

**[OME-133](/OME/issues/OME-133) (real checklist)**
- N1–N11 run once with the board's token. Results are recorded, and every [inferred] item in this doc is either confirmed or filed as a bug.

## 11. Board questions (the CEO raises them; nothing here can proceed on them without an answer)
- **B1. ngrok account.** Create or provide an ngrok account and put its authtoken into Paperclip as a secret (`ngrok_authtoken`, env `NGROK_AUTHTOKEN`), granted to the agent that runs the tunnel (QA for OME-133, the Lead for the sign-off demo). Also say which machine and operator hosts sessions.
- **B2. Plan / cost.** Free is enough for M2 sessions (1 GB, 20 000 requests/month, one fixed dev domain, visitor interstitial). A paid plan removes the interstitial and may be required for the `oauth` edge gate (N4 confirms). Approve free, or a named paid plan?
- **B3. Gating policy for M2.** Recommended: gate the whole room with ngrok OAuth + an email allowlist (the board supplies the emails). Alternative: basic-auth with one shared password, stored as a Paperclip secret. Or no gate, "public while hosted", accepting that anyone with the URL can join, chat and control until M3.
- **B4. Hosting window.** Confirm that the tunnel runs only during scheduled sessions, not 24/7, since the dev domain is fixed and public.
