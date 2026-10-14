//! One connection: a single task that owns the socket, drains the connection's outbox to it, reads frames, and
//! keeps the socket's timers (join timeout, `member-status` trailing publish, idle pings). One task, not a reader
//! and a writer: when the outbox ends (backpressure drop) the loop ends with it, so no session lingers until the
//! idle timeout, and a stalled client only stalls itself (publishers `try_send`, never wait).

use super::Slot;
use super::frames::close_with;
use super::handle::{Frame, flush_status, on_frame};
use super::limits::{Buckets, IDLE_TIMEOUT_MS, WS_BURST, WS_PER_SECOND};
use super::session::{closed, session_of};
use crate::app::App;
use crate::clock::Sleep;
use crate::contract::constants::close;
use crate::contract::ids::{MemberId, RoomId};
use crate::outbox::{ConnId, Outbound, channel};
use crate::rate_limit::TokenBucket;
use crate::registry::RoomCell;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use std::sync::Arc;
use std::time::Duration;

/// What a handler wants done with the socket's join timer once it returns.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimerCmd {
    Keep,
    Arm,
    Clear,
}

/// ws.ts `ConnData`: the socket's own state.
pub struct Conn {
    pub id: ConnId,
    /// Client key (ADR 0015 section 5).
    pub ip: String,
    /// False for loopback peers, which skip the per-key limits (join limiter, members per key).
    pub keyed: bool,
    /// The member this socket was joined as; it owns it only while the session's `conn` is this socket.
    pub member: Option<MemberId>,
    /// L1: every frame.
    pub bucket: TokenBucket,
    /// The socket's own until it joins; then its session's, so a resume doesn't refill them (ADR 0043).
    pub buckets: Buckets,
    /// Frames dropped in a row by any limiter. The first of a streak gets the one `rate_limited` notice.
    pub dropped: u32,
    /// `bad_message`s over the socket's life.
    pub bad: u32,
    /// The server started closing this socket: its remaining frames are ignored.
    pub closing: bool,
    pub join_timer: TimerCmd,
    /// Arm the `member-status` trailing publish in this many ms.
    pub status_in: Option<f64>,
}

impl Conn {
    fn new(ip: String, keyed: bool, now: f64) -> Self {
        Self {
            id: ConnId::next(),
            ip,
            keyed,
            member: None,
            bucket: TokenBucket::new(WS_BURST, WS_PER_SECOND, now),
            buckets: Buckets::new(now),
            dropped: 0,
            bad: 0,
            closing: false,
            join_timer: TimerCmd::Keep,
            status_in: None,
        }
    }
}

/// A timer that may not be armed: pending forever when it isn't.
async fn timer(t: &mut Option<Sleep>) {
    match t {
        Some(sleep) => sleep.await,
        None => std::future::pending().await,
    }
}

/// How long a close handshake may take before the connection is cut.
const CLOSE_WAIT: Duration = Duration::from_secs(1);

/// `open`: the connection after its upgrade. `cell` is `None` for a room that isn't registered (an id that was
/// taken down, or any well-formed id): closed 4006 or 4004 before any snapshot (OME-768).
pub async fn run(app: Arc<App>, mut socket: WebSocket, id: RoomId, cell: Option<Arc<RoomCell>>, ip: String, keyed: bool, _slot: Slot) {
    let mut conn = Conn::new(ip, keyed, app.mono());
    let (outbox, mut rx) = channel();
    let attached = cell
        .as_ref()
        .is_some_and(|c| c.lock_open().is_some_and(|mut inner| inner.attach_socket(conn.id, outbox).is_ok()));
    let Some(cell) = cell.filter(|_| attached) else {
        let (code, reason) = if crate::reports::is_taken_down(&app, &id) {
            (close::TAKEN_DOWN, "room taken down")
        } else {
            (close::ROOM_CLOSED, "room closed")
        };
        app.metrics.count_close(code);
        send_close(&mut socket, code, reason).await;
        return;
    };

    let mut join: Option<Sleep> = Some(app.clock.sleep(app.ws.join_timeout_ms));
    let mut status: Option<Sleep> = None;
    let idle_every = IDLE_TIMEOUT_MS / 2.0;
    let mut idle: Option<Sleep> = Some(app.clock.sleep(idle_every));
    let mut last_rx = app.mono();
    let mut sent_close = false;

    loop {
        tokio::select! {
            out = rx.recv() => match out {
                // The outbox died (backpressure) or the room dropped it: the connection ends without a close frame.
                None => break,
                Some(Outbound::Text(text)) => {
                    if socket.send(Message::Text(text)).await.is_err() {
                        break;
                    }
                }
                Some(Outbound::Close(code, reason)) => {
                    send_close(&mut socket, code, reason).await;
                    sent_close = true;
                    break;
                }
            },
            msg = socket.recv() => {
                let Some(Ok(msg)) = msg else { break };
                last_rx = app.mono();
                if conn.closing {
                    continue;
                }
                match &msg {
                    Message::Text(text) => on_frame(&app, &cell, &mut conn, Frame::Text(text.as_str())),
                    Message::Binary(_) => on_frame(&app, &cell, &mut conn, Frame::Binary),
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
                match std::mem::replace(&mut conn.join_timer, TimerCmd::Keep) {
                    TimerCmd::Keep => {}
                    TimerCmd::Arm => join = Some(app.clock.sleep(app.ws.join_timeout_ms)),
                    TimerCmd::Clear => join = None,
                }
                if let Some(wait) = conn.status_in.take() {
                    status = Some(app.clock.sleep(wait));
                }
            }
            () = timer(&mut join) => {
                join = None;
                if let Some(mut inner) = cell.lock_open()
                    && session_of(&inner, &conn).is_none()
                {
                    conn.closing = true;
                    close_with(&app, &mut inner, conn.id, close::JOIN_TIMEOUT, "join timeout");
                }
            }
            () = timer(&mut status) => {
                status = None;
                if let Some(mut inner) = cell.lock_open() {
                    let pending = session_of(&inner, &conn).filter(|s| s.status.pending).map(|s| s.member_id.clone());
                    if let Some(member) = pending {
                        flush_status(&app, &mut inner, &member);
                    }
                }
            }
            () = timer(&mut idle) => {
                // Anything received, a pong included, counts; silence for the whole timeout drops the socket.
                if app.mono() - last_rx >= IDLE_TIMEOUT_MS {
                    break;
                }
                if socket.send(Message::Ping(axum::body::Bytes::new())).await.is_err() {
                    break;
                }
                idle = Some(app.clock.sleep(idle_every));
            }
        }
    }

    if sent_close {
        // Let the client answer the close, so it reads our frame before the connection goes away.
        let _ = tokio::time::timeout(CLOSE_WAIT, async { while let Some(Ok(_)) = socket.recv().await {} }).await;
    }
    drop(socket);
    let mut inner = cell.lock();
    closed(&app, &cell, &mut inner, &conn);
}

async fn send_close(socket: &mut WebSocket, code: u16, reason: &'static str) {
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
        })))
        .await;
}
