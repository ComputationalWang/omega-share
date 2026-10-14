//! S5 (HTTP): routes, the Host/Origin gate, the in-flight cap, static files. S5 owns this file and its
//! submodules; `App` and `serve.rs` need no edit for it.

use crate::app::App;
use axum::Router;
use std::sync::Arc;

/// State S5 keeps on the app: the in-flight request cap and the HTTP limiters (share, failed share, room
/// creation, report keys...). Empty until S5 fills it.
#[derive(Debug, Default)]
pub struct HttpState {}

/// The HTTP routes, merged into the server's router by `serve`. Empty until S5.
pub fn router(app: Arc<App>) -> Router {
    let _ = app;
    Router::new()
}
