//! The wire contract, mirroring `packages/shared` (ADR 0050). Every type here is parsed at the
//! boundary; nothing past it handles unparsed input.

pub mod generic_embed;
pub mod js_compat;
pub mod session;
