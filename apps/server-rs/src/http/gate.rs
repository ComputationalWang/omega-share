//! The Host/Origin gate and the client key (server.ts `hostOk`, `originOk`, `isAllowedOrigin`, `ipOf`).

use crate::app::App;
use axum::http::HeaderMap;
use axum::response::Response;
use std::net::IpAddr;

/// 421 for a Host that is not ours (DNS rebinding), else 403 for an Origin that is not allowed, else `None`.
/// The layer around the router calls this for every request, upgrades included; S6 may call it again.
pub fn refusal(app: &App, headers: &HeaderMap) -> Option<Response> {
    let _ = (app, headers);
    None
}

/// Whether `origin` may call the API: the site, the public origin, our own loopback names, extension origins.
pub fn is_allowed_origin(app: &App, origin: &str) -> bool {
    let _ = (app, origin);
    false
}

/// The rate-limit key of a request: the peer, or behind the tunnel the client it forwarded.
pub fn client_key(app: &App, peer: Option<IpAddr>, headers: &HeaderMap) -> String {
    let _ = (app, peer, headers);
    String::new()
}
