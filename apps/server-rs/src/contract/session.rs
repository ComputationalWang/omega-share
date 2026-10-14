//! Durable room sessions (ADR 0043), mirroring `packages/shared/src/session.ts`.

/// How long a dropped durable member is held for a resume.
pub const RESUME_GRACE_MS: u32 = 120_000;
