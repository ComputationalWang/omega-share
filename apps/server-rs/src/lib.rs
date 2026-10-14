//! omega-share server (ADR 0050): the Rust port of `apps/server`. Layout and rules: `PORTING.md`.

pub mod clock;
pub mod config;
pub mod contract;
pub mod headers;
pub mod log;
pub mod rate_limit;
pub mod serve;
