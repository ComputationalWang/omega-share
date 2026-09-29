# ADR 0002 — Synced playback model

**Status:** accepted (2026-09-29)

**Decision:** The server holds the authoritative playback state for each room: `{embed, playing, position, rate, serverTimestamp, actor}`. Any user's play/pause/seek is sent to the server, and the last one to arrive wins. The server rebroadcasts the new state to the whole room. Each client works out the expected position (`position + (now - serverTimestamp) * rate` while playing) and corrects itself: drift > 1 s → seek; drift ≤ 1 s → a temporary rate nudge. Volume is local. The room never waits for buffering or ads. Only providers with a controllable player API are accepted (allowlist in `packages/shared`).

**Why:** simple, deterministic and testable. Waiting for everyone to buffer makes the whole room frustrating. Generic iframes can't be synced, and rejecting them also lowers the attack surface.
