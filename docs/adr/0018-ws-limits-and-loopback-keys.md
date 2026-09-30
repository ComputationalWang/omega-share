# ADR 0018 — WS limits: scopes, escalation, and loopback peers

**Status:** accepted (2026-09-30) · [OME-187](/OME/issues/OME-187), threat model `docs/research/m3-threat-model.md` §6 and §8, ADR 0016 §1 (the rates are server-private)

**Context:** M3 adds per-type, per-room and per-client-key limits to the WebSocket path. Some choices below are not in the threat model, and a later change could reverse them without noticing: which frames count against which limiter, what ends a flood streak, and which clients the per-key limits skip.

## Decision

### 1. Limiters and scopes

| Limiter | Scope | Burst / refill | On overflow |
|---|---|---|---|
| L1, every frame | socket | 20 / 10 s⁻¹ | `rate_limited` |
| chat | socket | 5 / 1 s⁻¹ | `rate_limited` |
| sit | socket | 4 / 1 s⁻¹ | `rate_limited` |
| L2, control | socket | 4 / 4 s⁻¹ | `rate_limited` |
| room control | room (all members' `control` together) | 8 / 4 s⁻¹ | `rate_limited` |
| join attempts | client key | 6 / 0.2 s⁻¹ | `rate_limited`, the socket stays unjoined |
| upgrades | client key | 10 / 0.5 s⁻¹ | HTTP 429 + `Retry-After` (seconds) |
| joined members | client key, per room | 5 (`MAX_MEMBERS_PER_CLIENT`) | `too_many_members`, the socket stays unjoined |

- A frame passes L1 first. Then it passes its own type's limiter, and for `control` the room limiter too. `retryAfterMs` is the time until the refusing bucket has a token, capped at `RETRY_AFTER_MAX_MS`.
- A `control` that passes L2 but fails the room limiter still uses up its L2 token. That is harmless, and it keeps the check simple.
- The member cap waits for the board's answer to B2 on OME-183. It is one named constant in `room.ts`.

### 2. Streaks and escalation

- A **dropped frame** is one that any rate limiter refused. The streak counts dropped frames in a row. It ends when a frame is accepted, meaning it passed every limiter and reached the handler.
- The first drop of a streak gets the one `rate_limited` notice. When a streak reaches 50 drops, the server closes the socket with `4029`.
- A `bad_message` neither extends nor ends a streak. The socket's 20th `bad_message` over its lifetime closes it with `4400`.
- `nickname_taken`, `too_many_members`, `already_joined` and `not_joined` are not drops.

### 3. Loopback peers skip the per-key limits

The join limiter, the upgrade limiter and the member cap skip a client key that is a loopback address (`isLoopbackKey`: `127.0.0.0/8`, or the `::1` key). The per-socket and per-room limits apply to every socket.

- **Why:** without the tunnel, the server binds `127.0.0.1` by default (ADR 0015 §3), so every local client shares one key. That includes the dev site, the e2e bots, the relay probe (25 sockets) and the load test. The per-key limits would make one developer look like a squatter. This follows the existing precedent: C1 already allows 50 sockets per key locally and 10 behind the proxy.
- **Behind the tunnel** (`TRUST_PROXY`), the key is the rightmost `X-Forwarded-For` entry. That is the real client, and it is never loopback. A request with a missing or unparseable header falls into the shared `proxy:unknown` key, which *is* limited.
- **Risk accepted:** a server exposed through a tunnel *without* `TRUST_PROXY` keys every client as loopback, so it skips the per-key limits. That setup is already a misconfiguration under ADR 0015 §5, because all clients would share one C1 bucket. The per-socket and per-room limits still apply.
- To reverse this later (for example, to test per-key limits without the proxy), change `isLoopbackKey` and give the local tools distinct keys.

### 4. Transport

- `backpressureLimit: 256 KiB` with `closeOnBackpressureLimit: true`. Bun closes a slow reader with 1006, so `4003 SLOW_CONSUMER` stays reserved.
- `idleTimeout: 60` and `sendPings: true`, both set explicitly.
- Measured on loopback: the kernel's socket buffers absorb a few MB before Bun's own buffer counts toward the limit. So a slow reader is dropped after about 5 MB of broadcasts, not 256 KiB. The test asserts it happens before 16 MB, which is Bun's default limit alone.

### 5. Clock

The limiters read an injected `Clock` (`ServerOptions.now`, default `performance.now`), so the tests move time by hand. The join timer and the `at` timestamps stay on real time.

## Consequences

- Tuning a rate is a server change in `ws.ts` (or `room.ts` for the member cap), with no contract issue.
- The relay probe paces `control` samples to the room limit. 50 control samples now take about 11 s.
- `apps/server/test/abuse.test.ts` pins every row of §1 and §2. `fuzz.test.ts` pins the §8 invariants.
