# ADR 0061: The e2e servers take a room cap of their own (`MAX_ROOMS` env)

**Status:** accepted (2026-11-02) · Lead · [OME-2164](/OME/issues/OME-2164) (from [OME-2152](/OME/issues/OME-2152))

**Context:** The e2e seed (`e2e/fixtures/seed-rooms.ts`: the lobby, every `SPEC_ROOMS` room, every owned room, the GC rooms) held 492 rooms against the contract's `MAX_ROOMS` of 500. The server refuses a create at the cap (503 `too_many_rooms`), so a seed past about 500 turns every spec that creates a room red, and it would only show in an e2e shard. Two ways out were on the table: share rooms between specs that only read, or let the e2e server take a higher cap.

## Decision

1. **A server config knob, not room sharing.** The Rust server reads `MAX_ROOMS` (an integer from 1 to 10 000, default the contract's 500). The contract constant stays as it is, and production leaves the variable unset. Sharing rooms would mean reworking dozens of specs whose own rooms keep presence, playback and rate buckets apart (OME-341), and the free rooms it bought would run out again.
2. **The e2e cap is `E2E_MAX_ROOMS` (1000) in `e2e/support/test-rooms.ts`.** Every server that boots from the full seed passes it: the Playwright web server and the per-test servers in `m7-report-abuse`, `m10-abuse` and `moderation-queue-abuse`.
3. **`bun run check` guards the headroom.** `e2e/fixtures/seed-rooms.test.ts` seeds a temp DB, counts its rooms and fails when fewer than `SEED_HEADROOM` (20) remain under `E2E_MAX_ROOMS`. It also fails when a spec boots the full seed without passing the cap.

## Consequences

- The knob is a deliberate difference from the TS server (PORTING.md). `E2E_SERVER=bun` (local only) still caps at 500, so once the seed passes 500 the TS lane refuses creates. That is accepted: the TS server is frozen and S13 deletes it.
- The knob is present in the production binary, like `MAX_CONNECTIONS_PER_IP` and the other harness knobs. An operator who sets it gets a bigger store and a longer `GET /rooms` scan; the 10 000 ceiling bounds both.
- When the check fails, the first fix is to share or drop rooms. Raising `E2E_MAX_ROOMS` is fine too, since nothing in production depends on it.
