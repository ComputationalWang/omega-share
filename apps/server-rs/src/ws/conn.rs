//! One connection: a connection task that reads frames and keeps the socket's timers (join timeout,
//! `member-status` trailing publish, idle), and a writer task that drains the connection's outbox into the sink.
//!
//! Why two tasks: a client that stops reading blocks its writer in a socket write. The connection task never
//! waits on the writer, so it still notices that the outbox died (`BACKPRESSURE_LIMIT`, Bun's
//! `closeOnBackpressureLimit`), aborts the writer and drops the connection with no close frame (1006), and then
//! runs the normal `closed` path: the member leaves or is held, the per-address slot is released. Publishers
//! only `try_send`, so a stalled client never slows anyone else.
//!
//! Deliberate difference: every socket write is bounded by `WRITE_TIMEOUT` (Bun has no such bound; it relies on
//! the backpressure limit), and so is the wait for a client's answer to our close.

use super::Slot;
use super::frames::close_with;
use super::handle::{Frame, flush_status, on_frame};
use super::limits::{MemberBuckets, WS_BURST, WS_PER_SECOND};
use super::session::{closed, session_of};
use crate::app::App;
use crate::clock::Sleep;
use crate::contract::constants::close;
use crate::contract::ids::{MemberId, RoomId};
use crate::metrics::SERVICE_RESTART;
use crate::outbox::{ConnId, Outbound, OutboxRx, channel};
use crate::rate_limit::TokenBucket;
use crate::registry::RoomCell;
use axum::extract::ws::{CloseFrame, Message, WebSocket};
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tokio::sync::Notify;
use tokio::task::AbortHandle;
use tokio::time::{Instant, MissedTickBehavior, interval_at, sleep};

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
    /// The socket's own until it joins; then its session's (swapped in), and handed back on `leave`.
    pub buckets: MemberBuckets,
    /// The `queue-add` bucket of a member that left, for this socket's next join (ws.ts `buckets.queue`).
    pub parked_add: Option<TokenBucket>,
    /// Frames dropped in a row by any limiter. The first of a streak gets the one `rate_limited` notice.
    pub dropped: u32,
    /// `bad_message`s over the socket's life.
    pub bad: u32,
    /// The server started closing this socket: its remaining frames are ignored.
    pub closing: bool,
    /// The frame just handled was a `leave`: the socket has no member any more.
    pub left: bool,
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
            buckets: MemberBuckets::new(now),
            parked_add: None,
            dropped: 0,
            bad: 0,
            closing: false,
            left: false,
            join_timer: TimerCmd::Keep,
            status_in: None,
        }
    }
}

/// Runs the session cleanup on every way out of the connection task, a panic in a handler included.
struct Closer {
    app: Arc<App>,
    cell: Arc<RoomCell>,
    conn: Conn,
    writer: AbortHandle,
}

impl Drop for Closer {
    fn drop(&mut self) {
        self.writer.abort();
        let mut inner = self.cell.lock();
        closed(&self.app, &self.cell, &mut inner, &self.conn);
    }
}

/// The socket's own timers run on real time, as the TS `setTimeout`s do: only the hold expiry (`schedule` in the TS)
/// follows the app clock, so a virtual clock moves holds and nothing else.
fn real_sleep(ms: f64) -> Sleep {
    Box::pin(sleep(Duration::from_secs_f64(ms.max(0.0) / 1000.0)))
}

/// A timer that may not be armed: pending forever when it isn't.
async fn timer(t: &mut Option<Sleep>) {
    match t {
        Some(sleep) => sleep.await,
        None => std::future::pending().await,
    }
}

/// How long one socket write, or a close handshake, may take before the connection is cut.
const WRITE_TIMEOUT: Duration = Duration::from_secs(10);
const CLOSE_WAIT: Duration = Duration::from_secs(1);

type Sink = SplitSink<WebSocket, Message>;

async fn send(sink: &mut Sink, msg: Message) -> bool {
    matches!(tokio::time::timeout(WRITE_TIMEOUT, sink.send(msg)).await, Ok(Ok(())))
}

fn close_message(code: u16, reason: &'static str) -> Message {
    Message::Close(Some(CloseFrame {
        code,
        reason: reason.into(),
    }))
}

/// The writer task: the outbox into the sink, and the idle pings. True if it ended by sending a close frame.
async fn write(mut sink: Sink, mut rx: OutboxRx, ping: Arc<Notify>) -> bool {
    loop {
        tokio::select! {
            out = rx.recv() => match out {
                // The outbox died or the room dropped it: the connection ends without a close frame.
                None => return false,
                Some(Outbound::Text(text)) => {
                    if !send(&mut sink, Message::Text(text)).await {
                        return false;
                    }
                }
                Some(Outbound::Close(code, reason)) => {
                    return send(&mut sink, close_message(code, reason)).await;
                }
            },
            () = ping.notified() => {
                if !send(&mut sink, Message::Ping(axum::body::Bytes::new())).await {
                    return false;
                }
            }
        }
    }
}

/// `open`: the connection after its upgrade. `cell` is `None` for a room that isn't registered (an id that was
/// taken down, or any well-formed id): closed 4006 or 4004 before any snapshot (OME-768).
pub async fn run(app: Arc<App>, mut socket: WebSocket, id: RoomId, cell: Option<Arc<RoomCell>>, ip: String, keyed: bool, _slot: Slot) {
    let conn = Conn::new(ip, keyed, app.mono());
    let (outbox, rx) = channel();
    let attached = cell.as_ref().is_some_and(|c| {
        c.lock_open().is_some_and(|mut inner| {
            if inner.attach_socket(conn.id, outbox).is_err() {
                return false;
            }
            // A drain that started after the upgrade was admitted: this socket is closed like the others (the flag is
            // set before `drain` walks the rooms, so one or the other sees it).
            if app.ws.draining.load(Ordering::Relaxed) {
                close_with(&app, &mut inner, conn.id, SERVICE_RESTART, "server restarting");
            }
            true
        })
    });
    let Some(cell) = cell.filter(|_| attached) else {
        let (code, reason) = if crate::reports::is_taken_down(&app, &id) {
            (close::TAKEN_DOWN, "room taken down")
        } else {
            (close::ROOM_CLOSED, "room closed")
        };
        app.metrics.count_close(code);
        let _ = tokio::time::timeout(WRITE_TIMEOUT, socket.send(close_message(code, reason))).await;
        return;
    };

    let dead = rx.dead_signal();
    let ping = Arc::new(Notify::new());
    let (sink, mut stream) = socket.split();
    let mut writer = tokio::spawn(write(sink, rx, ping.clone()));
    let mut guard = Closer {
        app: app.clone(),
        cell: cell.clone(),
        conn,
        writer: writer.abort_handle(),
    };
    let conn = &mut guard.conn;

    // Idle, pings, the join timer and the status flush are real time (the TS uses `setTimeout`); the hold expiry runs on the app clock.
    let idle_for = Duration::from_secs_f64((app.ws.idle_timeout_ms / 1000.0).max(0.001));
    let idle = sleep(idle_for);
    tokio::pin!(idle);
    let mut pings = interval_at(Instant::now() + idle_for / 2, idle_for / 2);
    pings.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut join: Option<Sleep> = Some(real_sleep(app.ws.join_timeout_ms));
    let mut status: Option<Sleep> = None;
    let mut sent_close = false;

    loop {
        tokio::select! {
            msg = stream.next() => {
                let Some(Ok(msg)) = msg else { break };
                idle.as_mut().reset(Instant::now() + idle_for);
                if conn.closing {
                    continue;
                }
                match &msg {
                    Message::Text(text) => on_frame(&app, &cell, conn, Frame::Text(text.as_str())),
                    Message::Binary(_) => on_frame(&app, &cell, conn, Frame::Binary),
                    Message::Close(_) => break,
                    Message::Ping(_) | Message::Pong(_) => {}
                }
                match std::mem::replace(&mut conn.join_timer, TimerCmd::Keep) {
                    TimerCmd::Keep => {}
                    TimerCmd::Arm => join = Some(real_sleep(app.ws.join_timeout_ms)),
                    TimerCmd::Clear => {
                        join = None;
                        status = None;
                    }
                }
                if let Some(wait) = conn.status_in.take() {
                    status = Some(real_sleep(wait));
                }
                // A new session (join) or none (leave): a trailing publish armed for the old one is stale.
                if conn.left {
                    status = None;
                }
            }
            done = &mut writer => {
                sent_close = done.unwrap_or(false);
                break;
            }
            () = dead.wait() => {
                // Backpressure: cut the connection with no close frame (1006), whatever the writer is stuck in.
                writer.abort();
                break;
            }
            () = &mut idle => break,
            _ = pings.tick() => ping.notify_one(),
            () = timer(&mut join) => {
                join = None;
                if let Some(mut inner) = cell.lock_open()
                    && session_of(&inner, conn.member.as_ref(), conn.id).is_none()
                {
                    conn.closing = true;
                    close_with(&app, &mut inner, conn.id, close::JOIN_TIMEOUT, "join timeout");
                }
            }
            () = timer(&mut status) => {
                status = None;
                if let Some(mut inner) = cell.lock_open() {
                    let pending = session_of(&inner, conn.member.as_ref(), conn.id)
                        .filter(|s| s.status.pending)
                        .map(|s| s.member_id.clone());
                    if let Some(member) = pending {
                        flush_status(&mut inner, &member);
                    }
                }
            }
        }
    }

    if sent_close {
        // Let the client answer the close, so it reads our frame before the connection goes away.
        let _ = tokio::time::timeout(CLOSE_WAIT, async { while let Some(Ok(_)) = stream.next().await {} }).await;
    }
    // `guard` drops here: the writer is aborted, both halves go, and `closed` runs.
}
