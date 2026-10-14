//! S6 (WebSocket): upgrade, join, resume, sessions, the connection tasks. S6 owns this file and its
//! submodules; `App` and `serve.rs` need no edit for it.
//!
//! Notes from the app core: enter a room with `App::with_open_room`; attach a socket with
//! `RoomInner::attach_socket` (refuses a closed room); when the writer ends because its outbox died, abort the
//! reader; teardown of sessions and join timers goes in `RoomInner::end_all`.

use crate::app::App;
use axum::Router;
use std::sync::Arc;

/// State S6 keeps on the app: the open-connection counter, per-client connection counts, the upgrade and join
/// limiters and the sessions bookkeeping that is not per room. Empty until S6 fills it.
#[derive(Debug, Default)]
pub struct WsState {}

/// The `/rooms/:id/ws` upgrade route, merged into the server's router by `serve`. Empty until S6.
pub fn router(app: Arc<App>) -> Router {
    let _ = app;
    Router::new()
}
