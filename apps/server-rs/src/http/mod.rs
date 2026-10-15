//! S5 (HTTP): routes, the Host/Origin gate, the in-flight cap, static files. S5 owns this file and its
//! submodules; `App` and `serve.rs` need no edit for it.
//!
//! `serve::build_router` merges [`router`] (every route of http.ts and the site) with S6's `/rooms/:id/ws`, and
//! [`wrap`]s the lot: the path rules of Bun's URL parser and Hono, the Host/Origin gate (421/403) for HTTP and
//! upgrades alike, the per-key request bucket and the in-flight cap (WebSocket upgrades have their own limiter),
//! the security headers on every response and HSTS for the https public host.
//!
//! ## API for S6
//! - `http::gate::refusal(&App, &HeaderMap) -> Option<Response>`: the 421/403 refusal, if any. The layer has already
//!   applied it by the time S6's handler runs; calling it again is harmless.
//! - `http::gate::client_key(&App, Option<IpAddr>, &HeaderMap) -> String`: `ipOf`. The layer also leaves it in the
//!   request extensions as `http::gate::ClientKey` (`Extension<ClientKey>`).
//! - `http::gate::is_allowed_origin(&App, &str) -> bool`.
//! - The peer address is `Extension<axum::extract::ConnectInfo<SocketAddr>>`, set by `http::server::serve`.

pub mod body;
pub mod gate;
pub mod mime;
pub mod path;
mod respond;
mod rooms;
pub mod server;
mod site;
pub mod site_meta;
#[cfg(test)]
mod tests;

use crate::app::App;
use crate::config::ServerConfig;
use crate::contract::constants::{
    ROOM_CREATE_GLOBAL_BURST, ROOM_CREATE_GLOBAL_REFILL_MS, ROOM_CREATE_KEY_BURST, ROOM_CREATE_KEY_REFILL_MS,
};
use crate::rate_limit::{DEFAULT_MAX_KEYS, KeyedLimiter, TokenBucket};
use crate::registry::{SHARE_BURST, SHARE_PER_SECOND};
use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Request, State};
use axum::http::header::{HeaderName, VARY};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, Uri};
use axum::middleware::{Next, from_fn_with_state};
use axum::response::Response;
use gate::{Allowed, ClientKey};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::AtomicUsize;
use std::sync::{Arc, Mutex, OnceLock};

/// Requests one client key may have in flight at once: a cold page load runs about 40 in parallel (http-limits.test.ts), so 64 is generous
/// for a person; it takes four keys to fill the global 256 (HTTP-2). A slot is held while the request is handled (its body read under the 5 s
/// total deadline) and released when the response head is produced: a response body that streams slowly is bounded by the connection caps and
/// `StallGuard`, not by this count.
pub const KEY_IN_FLIGHT: usize = 64;

/// The limiters of the API routes (http.ts `createHttpApp`).
#[derive(Debug)]
pub struct ApiLimits {
    pub creates: KeyedLimiter,
    pub global_creates: TokenBucket,
    pub failed_deletes: KeyedLimiter,
    pub shares: KeyedLimiter,
    pub global_shares: TokenBucket,
    pub failed_shares: KeyedLimiter,
}

/// State S5 keeps on the app: the HTTP request limiter and in-flight cap, the API limiters (creation, failed
/// deletes, shares, failed shares), and what is known once the listener has a port (Host/Origin allowlists, the
/// built site).
#[derive(Debug)]
pub struct HttpState {
    /// Per client key, every HTTP route.
    requests: Mutex<KeyedLimiter>,
    /// HTTP requests being handled at once.
    in_flight: AtomicUsize,
    /// Requests being handled per client key (not loopback).
    key_in_flight: Mutex<HashMap<String, usize>>,
    key_in_flight_max: AtomicUsize,
    api: Mutex<ApiLimits>,
    allowed: OnceLock<Allowed>,
    site: OnceLock<Option<site::Site>>,
    /// How long a request body may take in all, ms (bodies are a few KB: 5 s, Bun had no total).
    body_total_ms: std::sync::atomic::AtomicU64,
}

impl Default for HttpState {
    fn default() -> Self {
        // Buckets start full whatever `now` they are made at, so none needs the clock yet.
        let now = 0.0;
        let key_limiter = |burst: f64, per_second: f64| KeyedLimiter::new(burst, per_second, DEFAULT_MAX_KEYS);
        Self {
            requests: Mutex::new(key_limiter(gate::HTTP_BURST, gate::HTTP_PER_SECOND)),
            in_flight: AtomicUsize::new(0),
            key_in_flight: Mutex::new(HashMap::new()),
            key_in_flight_max: AtomicUsize::new(KEY_IN_FLIGHT),
            api: Mutex::new(ApiLimits {
                creates: key_limiter(f64::from(ROOM_CREATE_KEY_BURST), 1000.0 / ROOM_CREATE_KEY_REFILL_MS as f64),
                global_creates: TokenBucket::new(
                    f64::from(ROOM_CREATE_GLOBAL_BURST),
                    1000.0 / ROOM_CREATE_GLOBAL_REFILL_MS as f64,
                    now,
                ),
                failed_deletes: key_limiter(rooms::FAILED_DELETE_BURST, rooms::FAILED_DELETE_PER_SECOND),
                shares: key_limiter(SHARE_BURST, SHARE_PER_SECOND),
                global_shares: TokenBucket::new(rooms::GLOBAL_SHARE_BURST, rooms::GLOBAL_SHARE_PER_SECOND, now),
                failed_shares: key_limiter(rooms::FAILED_SHARE_BURST, rooms::FAILED_SHARE_PER_SECOND),
            }),
            allowed: OnceLock::new(),
            site: OnceLock::new(),
            body_total_ms: std::sync::atomic::AtomicU64::new(5_000),
        }
    }
}

impl HttpState {
    /// How long a request body may take in all.
    pub fn body_total(&self) -> std::time::Duration {
        std::time::Duration::from_millis(self.body_total_ms.load(std::sync::atomic::Ordering::Relaxed))
    }

    /// Overrides the total body read deadline (tests).
    pub fn set_body_total(&self, total: std::time::Duration) {
        self.body_total_ms.store(
            u64::try_from(total.as_millis()).unwrap_or(u64::MAX),
            std::sync::atomic::Ordering::Relaxed,
        );
    }

    /// Overrides the per-key cap on requests being handled (tests).
    pub fn set_key_in_flight(&self, max: usize) {
        self.key_in_flight_max.store(max, std::sync::atomic::Ordering::Relaxed);
    }

    fn key_in_flight_max(&self) -> usize {
        self.key_in_flight_max.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Called once the listener has a port: the Host and Origin allowlists need it (server.ts `allowedHosts`), and
    /// the built site's real path is resolved. The first call wins.
    pub fn bind(&self, config: &ServerConfig, port: u16) {
        let _ = self.allowed.set(Allowed::new(config, port));
        let _ = self.site.set(site::Site::new(config));
    }

    pub(crate) fn allowed(&self) -> Option<&Allowed> {
        self.allowed.get()
    }

    pub(crate) fn site(&self) -> Option<&site::Site> {
        self.site.get().and_then(Option::as_ref)
    }
}

/// The request as the routes see it: its path as Hono matches it (decoded), the client key, and the body unread.
pub(crate) struct Cx {
    pub app: Arc<App>,
    pub method: Method,
    pub path: String,
    pub headers: HeaderMap,
    pub key: String,
    pub body: Body,
}

/// The decoded path (`c.req.path`) the layer computed for the routes.
#[derive(Debug, Clone)]
struct RoutePath(String);

/// The HTTP routes, merged into the server's router by `serve`.
pub fn router(app: Arc<App>) -> Router {
    Router::new().fallback(dispatch).with_state(app)
}

/// The gate and the headers around every route (`serve` wraps the merged router in this). The layer sits outside
/// the router's own routing so it can rewrite the path first.
pub fn wrap(app: Arc<App>, routes: Router) -> Router {
    Router::new().fallback_service(routes).layer(from_fn_with_state(app, layer))
}

/// A header value we set ourselves: names and values are static.
fn set_static(headers: &mut HeaderMap, name: &'static str, value: &'static str) {
    headers.insert(HeaderName::from_static(name), HeaderValue::from_static(value));
}

/// `/rooms/<id>/ws`: the one route the HTTP limits skip (upgrades have their own limiter, ADR 0018).
fn is_ws_path(path: &str) -> bool {
    path.strip_prefix("/rooms/")
        .and_then(|rest| rest.split_once('/'))
        .is_some_and(|(id, tail)| !id.is_empty() && tail == "ws")
}

/// `Upgrade: websocket` (the handler checks the rest of the handshake).
fn is_upgrade(headers: &HeaderMap) -> bool {
    headers
        .get("upgrade")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("websocket"))
}

/// Bun's URL parser resolves dot segments before anything routes: the request's path becomes the normalized one.
fn normalized(uri: &Uri) -> Option<Uri> {
    let path = path::normalize_path(uri.path());
    if path == uri.path() {
        return None;
    }
    let target = match uri.query() {
        Some(q) => format!("{path}?{q}"),
        None => path,
    };
    let mut parts = uri.clone().into_parts();
    parts.path_and_query = target.parse().ok();
    Uri::from_parts(parts).ok()
}

async fn layer(State(app): State<Arc<App>>, mut req: Request, next: Next) -> Response {
    if let Some(uri) = normalized(req.uri()) {
        *req.uri_mut() = uri;
    }
    let route = path::route_path(req.uri().path());
    let host = req.headers().get("host").and_then(|h| h.to_str().ok()).map(str::to_ascii_lowercase);
    let hsts = host
        .as_deref()
        .is_some_and(|h| app.http.allowed().is_some_and(|a| a.is_hsts_host(h)));
    let mut res = gated(&app, req, next, route).await;
    if res.status() != StatusCode::SWITCHING_PROTOCOLS {
        for (name, value) in app.headers {
            set_static(res.headers_mut(), name, value);
        }
    }
    if hsts {
        set_static(res.headers_mut(), "strict-transport-security", crate::headers::HSTS);
    }
    res
}

async fn gated(app: &Arc<App>, mut req: Request, next: Next, route: String) -> Response {
    // Before routing, for HTTP and upgrades alike (ADR 0015 section 4).
    if let Some(refused) = gate::refusal(app, req.headers()) {
        return refused;
    }
    let peer = req.extensions().get::<ConnectInfo<SocketAddr>>().map(|c| c.0.ip());
    let key = gate::client_key(app, peer, req.headers());
    let upgrade_path = is_ws_path(req.uri().path());
    req.extensions_mut().insert(RoutePath(route));
    req.extensions_mut().insert(ClientKey(key.clone()));
    // Only the GET upgrade: any other method on the path is an ordinary request and is metered like one (WS-1).
    let upgrade = upgrade_path && req.method() == Method::GET && is_upgrade(req.headers());
    if upgrade {
        return next.run(req).await;
    }
    let _in_flight = match gate::admit_http(app, &key) {
        Ok(guard) => guard,
        Err(refused) => return *refused,
    };
    next.run(req).await
}

async fn dispatch(State(app): State<Arc<App>>, req: Request) -> Response {
    let (parts, body) = req.into_parts();
    let path = parts
        .extensions
        .get::<RoutePath>()
        .map_or_else(|| parts.uri.path().to_owned(), |p| p.0.clone());
    let key = parts
        .extensions
        .get::<ClientKey>()
        .map_or_else(|| "unknown".to_owned(), |k| k.0.clone());
    let cx = Cx {
        app,
        method: parts.method,
        path,
        headers: parts.headers,
        key,
        body,
    };
    let robots = cx.path.starts_with("/r/");
    let mut res = cors(cx).await;
    if robots {
        // Site routes (`/r/<id>`): a private room's link posted somewhere public must not be indexed (ADR 0028 section 4).
        set_static(res.headers_mut(), "x-robots-tag", "noindex, nofollow");
    }
    res
}

/// `apiCors` on `/rooms` and `/rooms/*`. The extension sends credentials for an edge gate's cookie, and Firefox
/// applies CORS to hosts granted at runtime, so extension origins need Allow-Credentials. Web origins never do:
/// auth is bearer-only (ADR 0015 section 4, OME-683).
async fn cors(cx: Cx) -> Response {
    let on_api = cx.path == "/rooms" || cx.path.starts_with("/rooms/");
    if !on_api {
        return routes(cx).await;
    }
    let app = cx.app.clone();
    let origin = cx.headers.get("origin").and_then(|v| v.to_str().ok()).unwrap_or("").to_owned();
    let allowed = !origin.is_empty() && gate::is_allowed_origin(&app, &origin);
    let extension = allowed && (origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://"));
    // `/rooms` matches both of the TS mounts (`/rooms` and `/rooms/*`), which doubles `Vary`.
    let both = cx.path == "/rooms";
    let preflight = cx.method == Method::OPTIONS;
    let mut res = if preflight {
        let mut res = Response::new(Body::empty());
        *res.status_mut() = StatusCode::NO_CONTENT;
        let h = res.headers_mut();
        set_static(h, "access-control-max-age", "600");
        set_static(h, "access-control-allow-methods", "GET,POST,DELETE");
        set_static(
            h,
            "access-control-allow-headers",
            "content-type,authorization,ngrok-skip-browser-warning",
        );
        res
    } else {
        routes(cx).await
    };
    let h = res.headers_mut();
    if allowed && let Ok(value) = HeaderValue::from_str(&origin) {
        h.insert(HeaderName::from_static("access-control-allow-origin"), value);
    }
    if extension {
        set_static(h, "access-control-allow-credentials", "true");
    }
    if preflight {
        set_static(h, "vary", "Origin, Access-Control-Request-Headers");
    } else if both {
        h.insert(VARY, HeaderValue::from_static("Origin, Origin"));
    } else {
        h.insert(VARY, HeaderValue::from_static("Origin"));
    }
    res
}

async fn routes(cx: Cx) -> Response {
    // Hono answers HEAD from the GET routes.
    let method = if cx.method == Method::HEAD {
        Method::GET
    } else {
        cx.method.clone()
    };
    let path = cx.path.clone();
    match (&method, path.as_str()) {
        (&Method::GET, "/healthz") => return rooms::healthz(&cx.app),
        (&Method::GET, "/") if cx.app.config.static_dir.is_none() => {
            return respond::with_type(StatusCode::OK, respond::TEXT, "omega-share server");
        }
        (&Method::GET, "/rooms") => return rooms::list(&cx.app),
        (&Method::POST, "/rooms") => return rooms::create(cx).await,
        _ => {}
    }
    if let Some(rest) = path.strip_prefix("/rooms/") {
        let parts: Vec<&str> = rest.split('/').collect();
        match (&method, parts.as_slice()) {
            (&Method::DELETE, [id]) if !id.is_empty() => return rooms::delete(&cx, id),
            (&Method::POST, [id, "share"]) if !id.is_empty() => return rooms::share(cx, id).await,
            (&Method::POST, [id, "queue"]) if !id.is_empty() => return rooms::queue(cx, id).await,
            (&Method::POST, [id, "report"]) if !id.is_empty() => return rooms::report(cx, id).await,
            _ => {}
        }
    }
    site::serve(&cx.app, &method, &path).await
}
