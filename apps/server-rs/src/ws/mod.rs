//! S6 (WebSocket): upgrade, join, resume, sessions, the connection tasks. S6 owns this file and its
//! submodules; `App` and `serve.rs` need no edit for it.
//!
//! Notes from the app core: enter a room with `App::with_open_room`; attach a socket with
//! `RoomInner::attach_socket` (refuses a closed room); when the writer ends because its outbox died, abort the
//! reader; teardown of sessions and join timers goes in `RoomInner::end_all`.

use crate::app::App;
use crate::store::SeatHold;
use axum::Router;
use std::sync::Arc;
use std::sync::atomic::AtomicU16;

/// State S6 keeps on the app: the open-connection counter, per-client connection counts, the upgrade and join
/// limiters and the sessions bookkeeping that is not per room.
///
/// The public fields are the knobs the TS tests pass to `startServer` (`joinTimeoutMs`, `statusIntervalMs`,
/// `maxConnectionsPerIp`); set them before the app is shared.
#[derive(Debug)]
pub struct WsState {
    /// Sockets that have not joined within this are closed (`joinTimeoutMs`, default 10 s).
    pub join_timeout_ms: f64,
    /// `member-status` coalescing interval (`statusIntervalMs`).
    pub status_interval_ms: f64,
    /// Open sockets allowed per client key; `None` is 50, or 10 behind a trusted proxy.
    pub max_per_ip: Option<usize>,
    port: AtomicU16,
}

impl Default for WsState {
    fn default() -> Self {
        Self {
            join_timeout_ms: 10_000.0,
            status_interval_ms: 1000.0,
            max_per_ip: None,
            port: AtomicU16::new(0),
        }
    }
}

impl WsState {
    /// The port the server listens on, for the Host and Origin allowlists. Call once after binding.
    pub fn set_port(&self, port: u16) {
        self.port.store(port, std::sync::atomic::Ordering::Relaxed);
    }

    /// Open sockets, joined or not (`omega_sockets`).
    pub fn connections(&self) -> usize {
        0
    }
}

/// The `/rooms/:id/ws` upgrade route, merged into the server's router by `serve`.
pub fn router(app: Arc<App>) -> Router {
    let _ = app;
    Router::new()
}

/// Graceful restart: closes every socket with SERVICE_RESTART and returns the seats held, for the store.
pub fn drain(app: &App) -> Vec<SeatHold> {
    let _ = app;
    Vec::new()
}
