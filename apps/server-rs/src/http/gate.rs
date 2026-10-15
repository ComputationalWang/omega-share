//! The Host/Origin gate, the client key and the HTTP flood limits (server.ts `hostOk`, `originOk`,
//! `isAllowedOrigin`, `ipOf`, `route`; http.ts `createHttpGate`).
//!
//! The layer around the whole router (`http::wrap`) runs the gate for every request, WebSocket upgrades included,
//! and leaves the client key in the request's extensions as [`ClientKey`]. S6's upgrade handler can extract it
//! (`Extension<ClientKey>`) or recompute it with [`client_key`]; [`refusal`] is the same check as a function.

use super::respond::{PLAIN, plain, retry_after, with_type};
use crate::app::App;
use crate::rate_limit::{self, is_loopback_key};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use std::collections::{HashMap, HashSet};
use std::net::IpAddr;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

/// The client key of the request (`ipOf`), set by the layer.
#[derive(Debug, Clone)]
pub struct ClientKey(pub String);

/// Per client key, every HTTP route (threat model section 10): a cold page load is about 30 requests, so a burst of
/// 120 covers a load and a few reloads; 20/s sustained is more than any person browsing needs.
pub const HTTP_BURST: f64 = 120.0;
pub const HTTP_PER_SECOND: f64 = 20.0;

/// The allowlists, known once the listener has a port.
#[derive(Debug)]
pub struct Allowed {
    hosts: HashSet<String>,
    origins: HashSet<String>,
    /// `chrome-extension://<id>` for each of `EXTENSION_IDS`, or `None` for any Chromium extension id.
    extension_origins: Option<Vec<String>>,
    /// The https public host: HSTS goes to it and nobody else.
    hsts_host: Option<String>,
}

impl Allowed {
    pub fn new(config: &crate::config::ServerConfig, port: u16) -> Self {
        let mut hosts = HashSet::new();
        let mut origins = HashSet::from([config.site_origin.clone()]);
        // Our own loopback names on our port: a page served from here (STATIC_DIR) is us.
        for name in ["localhost", "127.0.0.1", "[::1]"] {
            hosts.insert(format!("{name}:{port}"));
            origins.insert(format!("http://{name}:{port}"));
        }
        let mut hsts_host = None;
        if let Some(public) = &config.public_origin {
            if let Ok(url) = url::Url::parse(public)
                && let Some(host) = url.host_str()
            {
                let host = url.port().map_or_else(|| host.to_owned(), |p| format!("{host}:{p}"));
                if url.scheme() == "https" {
                    hsts_host = Some(host.clone());
                }
                hosts.insert(host);
            }
            origins.insert(public.clone());
        }
        let extension_origins = config
            .extension_ids
            .as_ref()
            .map(|ids| ids.iter().map(|id| format!("chrome-extension://{id}")).collect());
        Self {
            hosts,
            origins,
            extension_origins,
            hsts_host,
        }
    }

    fn origin_ok(&self, origin: &str) -> bool {
        self.origins.contains(origin)
            || is_firefox_extension(origin)
            || match &self.extension_origins {
                None => is_chrome_extension(origin),
                Some(pinned) => pinned.iter().any(|o| o == origin),
            }
    }

    /// Whether `host` (lowercase) is the https public host.
    pub fn is_hsts_host(&self, host: &str) -> bool {
        self.hsts_host.as_deref() == Some(host)
    }
}

/// `/^chrome-extension:\/\/[a-p]{32}$/`
fn is_chrome_extension(origin: &str) -> bool {
    origin
        .strip_prefix("chrome-extension://")
        .is_some_and(|id| id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b)))
}

/// `/^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/`: Firefox picks a random
/// UUID per install, so it can't be pinned; web pages can't send this scheme (ADR 0015 section 4).
fn is_firefox_extension(origin: &str) -> bool {
    let Some(uuid) = origin.strip_prefix("moz-extension://") else {
        return false;
    };
    let groups: Vec<&str> = uuid.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, n)| g.len() == n && g.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

/// Whether `origin` may call the API: the site, the public origin, our own loopback names, extension origins.
pub fn is_allowed_origin(app: &App, origin: &str) -> bool {
    app.http.allowed().is_some_and(|a| a.origin_ok(origin))
}

fn header<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|v| v.to_str().ok())
}

/// 421 for a Host that is not ours (DNS rebinding, ADR 0015 section 4), else 403 for an Origin that is not allowed
/// (browsers always send Origin cross-origin; non-browser clients may omit it and are not a CSRF vector), else
/// `None`. Before routing, for HTTP and upgrades alike.
pub fn refusal(app: &App, headers: &HeaderMap) -> Option<Response> {
    let Some(allowed) = app.http.allowed() else {
        return Some(plain(StatusCode::MISDIRECTED_REQUEST, "misdirected request"));
    };
    if !header(headers, "host").is_some_and(|h| allowed.hosts.contains(&h.to_ascii_lowercase())) {
        return Some(plain(StatusCode::MISDIRECTED_REQUEST, "misdirected request"));
    }
    // Not a ShareResponse: the contract has no code for it, and only a hostile page can trigger it.
    match headers.get("origin") {
        None => None,
        Some(origin) if origin.to_str().is_ok_and(|o| allowed.origin_ok(o)) => None,
        Some(_) => Some(plain(StatusCode::FORBIDDEN, "forbidden origin")),
    }
}

/// The rate-limit key of a request (`ipOf`): the peer, or behind the tunnel (`TRUST_PROXY=loopback`) the client it
/// forwarded (the rightmost `X-Forwarded-For` entry). `unknown` without a peer address.
pub fn client_key(app: &App, peer: Option<IpAddr>, headers: &HeaderMap) -> String {
    let Some(peer) = peer else {
        return "unknown".to_owned();
    };
    // Repeated headers read as one, joined with ", " (what `Headers.get` gives).
    let mut forwarded: Option<String> = None;
    for value in headers.get_all("x-forwarded-for") {
        let value = String::from_utf8_lossy(value.as_bytes());
        match &mut forwarded {
            Some(all) => {
                all.push_str(", ");
                all.push_str(&value);
            }
            None => forwarded = Some(value.into_owned()),
        }
    }
    rate_limit::client_key(&peer.to_string(), forwarded.as_deref(), app.config.trust_proxy)
}

/// Counts HTTP requests being handled, in all and per client key; drops the counts when the request ends or is
/// cancelled.
#[derive(Debug)]
pub struct InFlight<'a> {
    total: &'a AtomicUsize,
    key: Option<(&'a Mutex<HashMap<String, usize>>, String)>,
}

impl<'a> InFlight<'a> {
    /// `None` when `max` are already in flight.
    pub fn enter(counter: &'a AtomicUsize, max: usize) -> Option<Self> {
        if counter.fetch_add(1, Ordering::AcqRel) >= max {
            counter.fetch_sub(1, Ordering::AcqRel);
            return None;
        }
        Some(Self { total: counter, key: None })
    }

    /// Also counts against `key`: `false` (and nothing counted) when it already has `max`.
    fn enter_key(&mut self, keys: &'a Mutex<HashMap<String, usize>>, key: &str, max: usize) -> bool {
        let mut counts = keys.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        let n = counts.entry(key.to_owned()).or_insert(0);
        if *n >= max {
            if *n == 0 {
                counts.remove(key);
            }
            return false;
        }
        *n += 1;
        drop(counts);
        self.key = Some((keys, key.to_owned()));
        true
    }
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.total.fetch_sub(1, Ordering::AcqRel);
        if let Some((keys, key)) = self.key.take() {
            let mut counts = keys.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(n) = counts.get_mut(&key) {
                *n = n.saturating_sub(1);
                if *n == 0 {
                    counts.remove(&key);
                }
            }
        }
    }
}

/// The per-key bucket (429) and the cap on requests being handled (503) of `createHttpGate`: `Ok` with the
/// in-flight guard, or the refusal. Loopback keys skip the per-key bucket (ADR 0018 section 3).
pub fn admit_http<'a>(app: &'a App, key: &str) -> Result<InFlight<'a>, Box<Response>> {
    if !is_loopback_key(key) {
        let now = app.mono();
        let mut requests = crate::app::lock(&app.http.requests);
        if !requests.take(key, now) {
            let wait = requests.retry_after_ms(key, now) as u64;
            let mut res = with_type(StatusCode::TOO_MANY_REQUESTS, PLAIN, "too many requests");
            retry_after(&mut res, wait);
            return Err(Box::new(res));
        }
    }
    let busy = || {
        let mut res = with_type(StatusCode::SERVICE_UNAVAILABLE, PLAIN, "server busy");
        retry_after(&mut res, 1000);
        Box::new(res)
    };
    let mut guard = InFlight::enter(&app.http.in_flight, app.config.max_http_in_flight).ok_or_else(busy)?;
    // One key can't hold every slot with slow bodies (HTTP-2). A loopback key is local dev and tests and skips the
    // rate limits; behind a public origin (CFG-1) it is still capped in flight, all loopback clients together.
    let loopback = is_loopback_key(key);
    let capped = if loopback { "proxy:loopback" } else { key };
    if (!loopback || app.config.public_origin.is_some()) && !guard.enter_key(&app.http.key_in_flight, capped, app.http.key_in_flight_max())
    {
        return Err(busy());
    }
    Ok(guard)
}
