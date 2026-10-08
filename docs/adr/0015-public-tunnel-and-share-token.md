# ADR 0015 — Public tunnel: single origin, proxy-aware boundary, member-bound share token

**Status:** accepted (2026-09-30); §1 (tunnel as the public deploy) **superseded by [ADR 0020](0020-hosted-topology.md)** for the hosted site, the tunnel stays a local fallback · [OME-123](/OME/issues/OME-123), research [OME-119](/OME/issues/OME-119) (`docs/research/m2-tunnel-safety.md`) · **supersedes [ADR 0007](0007-share-endpoint-auth.md)** · gating (item 7) waits on board decision B3

**Context:** M2 makes the app reachable from the internet through a tunnel. A tunnel exposes one port, makes every peer `127.0.0.1`, and publishes a URL that doesn't change (the free ngrok dev domain is fixed). ADR 0007 assumed the flow was local and that per-address limits were meaningful. Neither holds now.

## Decision

1. **Topology.** The M2 public deploy is an operator-run tunnel (ngrok primary, `cloudflared` quick tunnel as fallback) in front of **one** `apps/server` process. That process serves the built site (`apps/web/dist`, via `hono/bun` `serveStatic`) and the API/WebSocket on **one origin**. Never tunnel the Vite dev server.
2. **ngrok is an operator tool, not a dependency.** It is a proprietary binary under a revocable licence, so nothing in the repo installs, bundles or imports it. Its authtoken is a Paperclip secret (`ngrok_authtoken`), injected only as the env var `NGROK_AUTHTOKEN` into the run that starts the tunnel. It is never in the repo, in a config file, in a comment, or echoed by scripts.
3. **Bind and config.** The server binds to `127.0.0.1` by default (Bun's default is `0.0.0.0`). Config is validated at startup, and a bad value exits non-zero: `PUBLIC_ORIGIN`, `SITE_ORIGIN`, `TRUST_PROXY=loopback|off` (default `off`), `STATIC_DIR`, and optionally `EXTENSION_IDS`.
4. **Host and Origin.** A request is refused with **421** unless `Host` is in the allowlist: the `PUBLIC_ORIGIN` host, plus `localhost`, `127.0.0.1` and `[::1]` on our port. That stops DNS rebinding. When `Origin` is present, it must be one of {site, public, allowed extension}, or the request gets **403**. The same rule applies to CORS and to the WebSocket upgrade.
5. **Proxy headers.** `X-Forwarded-For` is trusted **only** when `TRUST_PROXY=loopback` **and** the socket peer is a loopback address. Only the **rightmost** entry of the last XFF header is used, because that entry is the one the tunnel appended. `X-Forwarded-Host` and `X-Forwarded-Proto` are never used, since ngrok passes a client's `X-Forwarded-Host` through. The public origin comes from config, never from headers.
6. **Rate limits.** Every per-address limit keys on `clientKey(req)`, which is the address from item 5, reduced to its /64 for IPv6. Per-member share limit: burst 5, then 1 per 3 s. Behind the proxy, the per-client socket cap is 10 (it stays 50 locally for the load test). **Global ceilings** apply whatever the key: at most 200 open sockets (503), and shares at burst 20, then 2/s (429).
7. **Share endpoint.** `POST /rooms/:id/share` **always** requires `Authorization: Bearer <shareToken>`, not only in tunnel mode. The token is minted at `join`, sent only in that member's own `snapshot`, bound to `{roomId, memberId}`, and deleted on `leave` or socket close. A missing, malformed, revoked or wrong-room token gets **401 `unauthorized`**. `embed-changed.by` names the sharing member. The site keeps `{roomId, token}` in `sessionStorage["omega.share"]` and clears it on leave, `room-full` or close. The extension reads that record from an open room tab (`tabs.query` + `scripting.executeScript`, with no new permission) and Valibot-parses it.
8. **Nothing secret in page URLs.** The Twitch SDK forwards `location.href` as `referrer`, so room ids are not secret, and tokens and invites never go in URLs.
9. **Gating.** For M2, the whole tunnel is gated at the ngrok edge (the `oauth` action with an email allowlist kept in Paperclip) **if the board approves (B3)**. If it doesn't, M2 is "public while hosted": the tunnel runs only for a session, and the board accepts that anyone with the URL can join, chat and control playback until M3 moderation. Items 1–8 ship either way, and they are what CI tests.

## Wire contract (`packages/shared`, this issue)

- `ShareTokenSchema`: exactly `SHARE_TOKEN_LENGTH` (22) base64url characters, which is 16 random bytes from `crypto.getRandomValues` with no padding.
- `snapshot.shareToken?: ShareToken`. It is **optional**, so a pre-M2 server's snapshot still parses. A site that gets no token cannot share, and it writes no record. OME-128's server always sends one.
- `parseShareAuthorization(header)` returns the token, or `null` for a missing or malformed header. The scheme is case-insensitive, with exactly one space and nothing after the token. The server uses it at the boundary.
- `SHARE_TOKEN_STORAGE_KEY = "omega.share"` and `ShareTokenRecordSchema = strict { roomId, token }` define the shape the site writes and the extension parses.
- `ShareErrorCode` gains `"unauthorized"`. `ShareRequest` is unchanged, because the token travels in the header: it isn't logged with bodies, and it makes the request non-simple for CORS.
- `embed-changed.by` stays `MemberId | null`. Only its meaning changes: null now means server-initiated. There is no new client message. Every change is additive (ADR 0003 has no version field to bump).

## Threats and controls

Each row is covered by a test in the named issue. QA checks this list against the safety tests.

| # | Threat | Control | Test |
|---|---|---|---|
| T-01 | Drive-by share from curl, no token | Token required → 401 `unauthorized` | shared schema (this ADR) + server unit + proxy e2e |
| T-02 | Share with the token of a member who left | Token deleted on leave or close → 401 | server unit |
| T-03 | Token for room A used on room B | Token bound to a room → 401 | server unit |
| T-04 | Hostile page POSTs a share from a visitor's browser | Origin allowlist → 403; token not readable cross-origin | proxy e2e (`evil.test` page) |
| T-05 | Cross-site WebSocket hijack | Upgrade Origin allowlist → 403 | proxy e2e |
| T-06 | DNS rebinding to the loopback server | `Host` allowlist → 421 | server unit + proxy e2e |
| T-07 | Spoofed XFF to dodge a limit | Rightmost entry only, from a loopback peer with `TRUST_PROXY` | server unit + proxy e2e |
| T-08 | XFF sent directly, bypassing the tunnel | Ignored unless the peer is loopback and `TRUST_PROXY` is set | server unit |
| T-09 | One client opens many sockets and locks everyone out | Per-client cap 10, global cap 200 | proxy e2e |
| T-10 | Many-address share flood | Per-member + global share buckets → 429 | server unit |
| T-11 | Server reachable from the LAN | Default bind `127.0.0.1` | server unit |
| T-12 | Mixed content or wrong scheme behind TLS | Same-origin base URL; `wss:` derived from `https:` | proxy e2e |
| T-13 | Clickjacking | `frame-ancestors 'none'` | proxy e2e |
| T-14 | Authtoken leak | Paperclip secret via env only; wrapper never echoes env | review checklist |
| T-15 | Garbled or oversized `Authorization` header | `parseShareAuthorization` checks length first, then an anchored regex → null → 401 | shared schema (`share-token.test.ts`) |
| T-16 | Token leaks through a page URL or the Twitch referrer | Token only in `sessionStorage` and a header, never in a URL | site unit (OME-128) |

## Consequences

- The e2e specs that POST `/share` directly must join first and send the token ([OME-132](/OME/issues/OME-132)).
- Server work goes to [OME-128](/OME/issues/OME-128), extension work to [OME-130](/OME/issues/OME-130), the reverse-proxy e2e fixture to [OME-132](/OME/issues/OME-132), and the real-ngrok checklist to [OME-133](/OME/issues/OME-133).
- Every server change keeps the rate-limit primitives allocation-free per call. The perf budgets are unchanged.

**Revisit when:** there's a hosted deploy without a tunnel, multiple or private rooms, or moderation (M3).
