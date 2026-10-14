//! S7 (operations): the admin socket and CLI, the metrics listener, backup, the graceful restart. S7 owns this
//! file; `App` and `serve.rs` need no edit for it (it serves no routes on the public router).

/// State S7 keeps on the app: the admin socket and the metrics listener (their handles and the drain flag).
/// Empty until S7 fills it.
#[derive(Debug, Default)]
pub struct OpsState {}
