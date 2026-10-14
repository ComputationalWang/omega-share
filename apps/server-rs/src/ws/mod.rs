//! S6 (WebSocket): the `/rooms/:id/ws` upgrade, joins, sessions and the connection tasks (ws.ts, ws-sessions.ts,
//! ws-limits.ts).
//!
//! The relay path (chat, control, presence, status, ping) takes the room's lock, serializes the frame once and
//! `try_send`s a refcount clone to every subscriber's outbox: no store access, no allocation per subscriber, no
//! `.await` under a lock. A room is entered only through `RoomCell::lock_open`.

mod conn;
mod frames;
mod gate;
mod handle;
pub mod limits;
pub mod session;

use crate::app::{App, lock};
use crate::contract::constants::MAX_CLIENT_MESSAGE_BYTES;
use crate::contract::ids::RoomId;
use crate::metrics::SERVICE_RESTART;
use crate::rate_limit::{DEFAULT_MAX_KEYS, KeyedLimiter, is_loopback_key};
use crate::store::SeatHold;
use axum::Router;
use axum::extract::ws::rejection::WebSocketUpgradeRejection;
use axum::extract::{ConnectInfo, State, WebSocketUpgrade};
use axum::http::{HeaderMap, HeaderName, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use limits::{FAILED_BURST, FAILED_PER_SECOND, JOIN_BURST, JOIN_PER_SECOND, UPGRADE_BURST, UPGRADE_PER_SECOND};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// Open sockets one client key may hold: 50, or 10 behind a trusted proxy (every client then has its own key).
const MAX_PER_IP: usize = 50;
const MAX_PER_IP_PROXIED: usize = 10;

/// State S6 keeps on the app: the open-connection counters, the upgrade and join limiters.
///
/// The public fields are the knobs the TS tests pass to `startServer` (`joinTimeoutMs`, `statusIntervalMs`,
/// `maxConnectionsPerIp`); set them before the app is shared.
#[derive(Debug)]
pub struct WsState {
    /// Sockets that have not joined within this are closed (`joinTimeoutMs`, default 10 s).
    pub join_timeout_ms: f64,
    /// `member-status` coalescing interval (`statusIntervalMs`, default 1 s).
    pub status_interval_ms: f64,
    /// Open sockets allowed per client key; `None` is 50, or 10 behind a trusted proxy.
    pub max_per_ip: Option<usize>,
    /// A socket silent for this long is dropped; the server pings at half of it (`idleTimeout`, 60 s).
    pub idle_timeout_ms: f64,
    port: AtomicU16,
    draining: AtomicBool,
    connections: AtomicUsize,
    per_ip: Mutex<HashMap<String, usize>>,
    upgrades: Mutex<KeyedLimiter>,
    joins: Mutex<KeyedLimiter>,
    failed_owners: Mutex<KeyedLimiter>,
    failed_invites: Mutex<KeyedLimiter>,
}

impl Default for WsState {
    fn default() -> Self {
        let limiter = |burst, per_second| Mutex::new(KeyedLimiter::new(burst, per_second, DEFAULT_MAX_KEYS));
        Self {
            join_timeout_ms: 10_000.0,
            status_interval_ms: 1000.0,
            max_per_ip: None,
            idle_timeout_ms: 60_000.0,
            port: AtomicU16::new(0),
            draining: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            per_ip: Mutex::new(HashMap::new()),
            upgrades: limiter(UPGRADE_BURST, UPGRADE_PER_SECOND),
            joins: limiter(JOIN_BURST, JOIN_PER_SECOND),
            failed_owners: limiter(FAILED_BURST, FAILED_PER_SECOND),
            failed_invites: limiter(FAILED_BURST, FAILED_PER_SECOND),
        }
    }
}

impl WsState {
    /// The knobs the config sets; the limiters start full.
    pub fn from_config(config: &crate::config::ServerConfig) -> Self {
        Self {
            join_timeout_ms: f64::from(config.join_timeout_ms),
            status_interval_ms: f64::from(config.status_interval_ms),
            max_per_ip: config.max_connections_per_ip.map(|n| n as usize),
            ..Self::default()
        }
    }

    /// The port the server listens on, for the Host and Origin allowlists. Call once after binding.
    pub fn set_port(&self, port: u16) {
        self.port.store(port, Ordering::Relaxed);
    }

    /// Open sockets, joined or not (`omega_sockets`).
    pub fn connections(&self) -> usize {
        self.connections.load(Ordering::Relaxed)
    }
}

/// One open socket's place in the totals; releases it when dropped, wherever the connection ends.
pub struct Slot {
    app: Arc<App>,
    ip: String,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let state = &self.app.ws;
        let mut per_ip = lock(&state.per_ip);
        match per_ip.get_mut(&self.ip) {
            Some(n) if *n > 1 => *n -= 1,
            _ => {
                per_ip.remove(&self.ip);
            }
        }
        state.connections.fetch_sub(1, Ordering::Relaxed);
    }
}

fn plain(app: &App, status: StatusCode, text: &'static str) -> Response {
    let mut res = (status, text).into_response();
    for (name, value) in app.headers {
        res.headers_mut()
            .insert(HeaderName::from_static(name), HeaderValue::from_static(value));
    }
    res
}

/// `^/rooms/([^/]+)/ws$` on the raw path: the id is not percent-decoded, as in the TS.
fn room_id_of(uri: &Uri) -> Option<&str> {
    let id = uri.path().strip_prefix("/rooms/")?.strip_suffix("/ws")?;
    (!id.is_empty() && !id.contains('/')).then_some(id)
}

/// The `/rooms/:id/ws` upgrade route, merged into the server's router by `serve`. The server must be made with
/// `into_make_service_with_connect_info::<SocketAddr>()`: the client key comes from the peer address.
pub fn router(app: Arc<App>) -> Router {
    Router::new().route("/rooms/{id}/ws", get(upgrade)).with_state(app)
}

/// server.ts `route` for a WebSocket upgrade: gate, upgrade limiter, room, connection caps, handshake.
async fn upgrade(
    State(app): State<Arc<App>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
    ws: Result<WebSocketUpgrade, WebSocketUpgradeRejection>,
) -> Response {
    let port = app.ws.port.load(Ordering::Relaxed);
    // S5 replaces: the Host and Origin gate runs before routing, for HTTP and upgrades alike (ADR 0015 section 4).
    if let Err(gate::Refusal(status, text)) = gate::check(&app, port, &headers) {
        return plain(&app, status, text);
    }
    let ip = gate::ip_of(&app, peer, &headers);
    let keyed = !is_loopback_key(&ip);
    // Before the lookup, so probing for room ids costs a token like a real upgrade (threat model S5).
    if keyed {
        let now = app.mono();
        let mut upgrades = lock(&app.ws.upgrades);
        if !upgrades.take(&ip, now) {
            let wait = upgrades.retry_after_ms(&ip, now);
            drop(upgrades);
            let mut res = plain(&app, StatusCode::TOO_MANY_REQUESTS, "reconnecting too fast");
            if let Ok(value) = HeaderValue::from_str(&((wait / 1000.0).ceil() as u64).to_string()) {
                res.headers_mut().insert("retry-after", value);
            }
            return res;
        }
    }
    let Some(raw) = room_id_of(&uri) else {
        return plain(&app, StatusCode::NOT_FOUND, "not found");
    };
    let id = RoomId::parse(raw);
    // A taken-down id still upgrades, to an unregistered stand-in, so the client hears 4006 rather than a bare 404
    // (ADR 0033 section 6); so does any other well-formed id (OME-768): it closes 4004 before any snapshot.
    let cell = id.as_ref().and_then(|id| app.registry.get(id));
    let known = cell.is_some() || id.as_ref().is_some_and(|id| crate::reports::is_taken_down(&app, id));
    let Some(id) = id else {
        return plain(&app, StatusCode::NOT_FOUND, "unknown room");
    };
    if app.ws.draining.load(Ordering::Relaxed) {
        return plain(&app, StatusCode::SERVICE_UNAVAILABLE, "server restarting");
    }
    let slot = match reserve(&app, &ip) {
        Ok(slot) => slot,
        Err(refusal) => return plain(&app, refusal.0, refusal.1),
    };
    match ws {
        Ok(ws) => ws
            .max_message_size(MAX_CLIENT_MESSAGE_BYTES)
            .max_frame_size(MAX_CLIENT_MESSAGE_BYTES)
            .on_upgrade(move |socket| conn::run(app, socket, id, cell, ip, keyed, slot)),
        // A plain request without a handshake.
        Err(_) if known => plain(&app, StatusCode::UPGRADE_REQUIRED, "expected a WebSocket upgrade"),
        Err(_) => plain(&app, StatusCode::NOT_FOUND, "unknown room"),
    }
}

/// The total and per-address caps: counted at the upgrade, released when the `Slot` drops.
fn reserve(app: &Arc<App>, ip: &str) -> Result<Slot, (StatusCode, &'static str)> {
    let state = &app.ws;
    let cap = state
        .max_per_ip
        .unwrap_or(if app.config.trust_proxy { MAX_PER_IP_PROXIED } else { MAX_PER_IP });
    let mut per_ip = lock(&state.per_ip);
    if state.connections.load(Ordering::Relaxed) >= app.config.max_connections as usize {
        return Err((StatusCode::SERVICE_UNAVAILABLE, "server full"));
    }
    let open = per_ip.entry(ip.to_owned()).or_insert(0);
    if *open >= cap {
        return Err((StatusCode::TOO_MANY_REQUESTS, "too many connections"));
    }
    *open += 1;
    state.connections.fetch_add(1, Ordering::Relaxed);
    Ok(Slot {
        app: app.clone(),
        ip: ip.to_owned(),
    })
}

/// Graceful restart (`drain` in server.ts): takes no new sockets, closes every socket with SERVICE_RESTART
/// (clients reconnect on their own) and returns the seats held, for the store to keep. The seats are read before
/// the closes, which end the members that are not durable.
pub fn drain(app: &App) -> Vec<SeatHold> {
    app.ws.draining.store(true, Ordering::Relaxed);
    let holds = app.seat_holds();
    app.close_all_sockets(SERVICE_RESTART, "server restarting");
    holds
}
