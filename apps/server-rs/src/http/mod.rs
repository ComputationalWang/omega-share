//! S5 (HTTP): routes, the Host/Origin gate, the in-flight cap, static files. S5 owns this file and its
//! submodules; `App` and `serve.rs` need no edit for it.

pub mod gate;
pub mod mime;
pub mod path;
pub mod server;
pub mod site_meta;
#[cfg(test)]
mod tests;

use crate::app::App;
use crate::config::ServerConfig;
use axum::Router;
use std::sync::Arc;

/// State S5 keeps on the app: the in-flight request cap and the HTTP limiters (share, failed share, room
/// creation, report keys...). Empty until S5 fills it.
#[derive(Debug, Default)]
pub struct HttpState {}

impl HttpState {
    /// Called once the listener has a port: the Host and Origin allowlists need it (server.ts `allowedHosts`).
    pub fn bind(&self, config: &ServerConfig, port: u16) {
        let _ = (config, port);
    }
}

/// The HTTP routes, merged into the server's router by `serve`. Empty until S5.
pub fn router(app: Arc<App>) -> Router {
    let _ = app;
    Router::new()
}

/// The gate and the headers around every route (`serve` wraps the merged router in this).
pub fn wrap(app: Arc<App>, routes: Router) -> Router {
    let _ = app;
    routes
}
