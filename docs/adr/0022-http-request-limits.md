# ADR 0022 — HTTP request limits: per-key bucket and global in-flight cap

**Status:** accepted (2026-10-01) · [OME-274](/OME/issues/OME-274), threat model §10 "HTTP floods", ADR 0015 §5 (keying), ADR 0018 §3 (loopback keys)

**Context:** Before M4 only the share route and WebSocket upgrades were limited. Any client could flood static files, `/rooms` or `/healthz` without bound. This ADR is the app-level part. The per-IP connection cap in the host firewall belongs to the deploy kit.

## Decision

| Limit | Scope | Value | On overflow |
|---|---|---|---|
| HTTP requests | client key (`clientKey`) | burst 120, refill 20 s⁻¹ | `429 too many requests` + `Retry-After` (seconds, ≥ 1) |
| HTTP in flight | whole server | 256 (`ServerOptions.maxHttpInFlight`) | `503 server busy` + `Retry-After: 1` |

- **Every HTTP route counts:** static files, `/rooms`, share, `/healthz`, and 404s. The share route's own limiters (`http.ts`) still apply after this one.
- **Upgrades don't count.** A `/rooms/:id/ws` request goes through the upgrade limiter (ADR 0018 §1) and never touches the HTTP bucket. Host and Origin refusals (421/403) come first and don't count either.
- **Why these numbers:** a cold page load of `apps/web/dist` is about 30 requests (29 files with source maps, plus `/rooms`). A burst of 120 covers a load and a few reloads. 20/s sustained is more than any person browsing needs. `test/http-limits.test.ts` runs two 42-request loads back to back from one key.
- **In flight** means from routing until the handler returns its `Response`. File bodies stream after that and don't hold a slot. A slow share body does hold one until it is read or refused.
- **Loopback keys skip the per-key bucket** (ADR 0018 §3, same reasons: local dev, e2e, the load probe and perf all share `127.0.0.1`). The in-flight cap applies to everyone. Behind the tunnel with `TRUST_PROXY` the key is the forwarded client, never loopback. A missing or unparseable `X-Forwarded-For` header falls into `proxy:unknown`, which is limited.
- The bucket map is a `KeyedLimiter` (at most 1024 keys, least recently used evicted first), so memory stays bounded under key rotation.

## Consequences

- Tuning is a server change in `http.ts` (`HTTP_BURST`, `HTTP_PER_SECOND`, `MAX_HTTP_IN_FLIGHT`). No contract issue is needed, because `Retry-After` is plain HTTP.
- A household behind one NAT shares one bucket. At 120/20 s⁻¹ that only matters for several cold loads in the same second.
