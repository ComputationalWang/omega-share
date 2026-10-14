//! omega-share server (ADR 0050): the Rust port of `apps/server`. Layout and rules: `PORTING.md`.

pub mod app;
pub mod backup;
pub mod cli;
pub mod clock;
pub mod config;
pub mod contract;
pub mod embed_policy;
pub mod headers;
pub mod http;
pub mod log;
pub mod metrics;
pub mod ops;
pub mod outbox;
pub mod owner_edits;
pub mod playback;
pub mod presets;
pub mod queue;
pub mod rate_limit;
pub mod registry;
pub mod reports;
pub mod room;
pub mod rooms_gc;
pub mod secrets;
pub mod serve;
pub mod store;
pub mod ws;
