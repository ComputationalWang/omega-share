//! The Host and Origin gate for the upgrade (server.ts `hostOk`, `originOk`, `isAllowedOrigin`, `ipOf`).
//!
//! S5 REPLACES THIS: the HTTP slice owns the real gate and applies it to every route; this private copy only lets
//! the upgrade route be refused the same way until that lands. Delete it and call S5's function.

use crate::app::App;
use crate::rate_limit::client_key;
use axum::http::{HeaderMap, StatusCode};
use std::net::SocketAddr;

/// A refusal: status and plain-text body, answered before the handshake.
pub struct Refusal(pub StatusCode, pub &'static str);

/// `new URL(origin).host`: the host, and the port unless it is the scheme's default.
fn host_of(origin: &str) -> Option<String> {
    let url = url::Url::parse(origin).ok()?;
    let host = url.host_str()?;
    Some(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}

fn is_chromium_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// Firefox picks a random UUID per install, so it can't be pinned; web pages can't send this scheme (ADR 0015 section 4).
fn is_firefox_uuid(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    let lens = [8, 4, 4, 4, 12];
    groups.len() == 5
        && groups
            .iter()
            .zip(lens)
            .all(|(g, len)| g.len() == len && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn is_allowed_origin(app: &App, port: u16, origin: &str) -> bool {
    if origin == app.config.site_origin || app.config.public_origin.as_deref() == Some(origin) {
        return true;
    }
    if ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|name| origin == format!("http://{name}:{port}"))
    {
        return true;
    }
    if let Some(id) = origin.strip_prefix("moz-extension://") {
        return is_firefox_uuid(id);
    }
    let Some(id) = origin.strip_prefix("chrome-extension://") else {
        return false;
    };
    match &app.config.extension_ids {
        None => is_chromium_id(id),
        Some(ids) => ids.iter().any(|allowed| allowed == id),
    }
}

/// Refuses DNS rebinding (only our public host and loopback names on our port, ADR 0015 section 4) and foreign
/// origins (browsers always send Origin cross-origin; non-browser clients may omit it and are not a CSRF vector).
pub fn check(app: &App, port: u16, headers: &HeaderMap) -> Result<(), Refusal> {
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    let ours = ["localhost", "127.0.0.1", "[::1]"]
        .iter()
        .any(|name| host == format!("{name}:{port}"))
        || app.config.public_origin.as_deref().and_then(host_of).is_some_and(|h| h == host);
    if !ours {
        return Err(Refusal(StatusCode::MISDIRECTED_REQUEST, "misdirected request"));
    }
    match headers.get("origin") {
        None => Ok(()),
        Some(origin) if origin.to_str().is_ok_and(|o| is_allowed_origin(app, port, o)) => Ok(()),
        Some(_) => Err(Refusal(StatusCode::FORBIDDEN, "forbidden origin")),
    }
}

/// `ipOf`: the client key (ADR 0015 section 5).
pub fn ip_of(app: &App, peer: SocketAddr, headers: &HeaderMap) -> String {
    let forwarded: Vec<&str> = headers.get_all("x-forwarded-for").iter().filter_map(|v| v.to_str().ok()).collect();
    let forwarded = (!forwarded.is_empty()).then(|| forwarded.join(", "));
    client_key(&peer.ip().to_string(), forwarded.as_deref(), app.config.trust_proxy)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extension_ids_have_the_shapes_the_browsers_use() {
        assert!(is_chromium_id("abcdefghijklmnopabcdefghijklmnop"));
        assert!(!is_chromium_id("abcdefghijklmnopabcdefghijklmnoq"));
        assert!(!is_chromium_id("abc"));
        assert!(is_firefox_uuid("123e4567-e89b-12d3-a456-426614174000"));
        assert!(!is_firefox_uuid("123E4567-e89b-12d3-a456-426614174000"));
        assert!(!is_firefox_uuid("123e4567e89b12d3a456426614174000"));
    }

    #[test]
    fn host_of_keeps_a_non_default_port_only() {
        assert_eq!(host_of("https://omega.example").as_deref(), Some("omega.example"));
        assert_eq!(host_of("https://omega.example:8443").as_deref(), Some("omega.example:8443"));
        assert_eq!(host_of("https://omega.example:443").as_deref(), Some("omega.example"));
    }
}
