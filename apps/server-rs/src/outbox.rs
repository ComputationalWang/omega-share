//! The subscriber queue of one connection, and the room's list of them (ws.ts `server.publish` /
//! `ws.publish`, `backpressureLimit` + `closeOnBackpressureLimit`).
//!
//! A frame is serialized once into a [`Utf8Bytes`] and cloned (refcount) into each subscriber's [`Outbox`] with
//! `try_send`: publishing never blocks and never awaits, so no subscriber slows another. S6's writer task owns
//! the [`OutboxRx`] and drains it to the socket. A subscriber whose queue holds more than `BACKPRESSURE_LIMIT`
//! bytes (or whose channel is full) is marked dead and dropped from the room: its writer sees `None` from
//! [`OutboxRx::recv`] and drops the connection WITHOUT a close frame, so the client sees 1006, as with Bun.

use crate::contract::server_message::{ServerMessage, encode};
use crate::log::{LogEvent, log_error};
use crate::registry::RoomInner;
use axum::extract::ws::Utf8Bytes;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tokio::sync::mpsc;

/// `BACKPRESSURE_LIMIT` (ws-limits.ts): queued bytes past this drop the connection.
pub const BACKPRESSURE_LIMIT: usize = 256 * 1024;

/// Frames an outbox may hold whatever their size; far above anything the byte limit lets through for real frames.
pub const OUTBOX_FRAMES: usize = 4096;

/// A cheap id for one open connection (not a member: a socket may not have joined, and a member may resume on another).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnId(pub u64);

impl ConnId {
    /// A process-unique id.
    pub fn next() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Self(NEXT.fetch_add(1, Ordering::Relaxed))
    }
}

/// What the writer task sends on the socket.
#[derive(Debug, Clone)]
pub enum Outbound {
    Text(Utf8Bytes),
    /// A close frame (code, reason); the writer ends after it.
    Close(u16, &'static str),
}

/// The sending half, kept in the room's [`Subscribers`]. Not `Clone`: when the room drops it the writer's queue ends.
#[derive(Debug)]
pub struct Outbox {
    tx: mpsc::Sender<Outbound>,
    queued: Arc<AtomicUsize>,
    dead: Arc<AtomicBool>,
}

/// The receiving half: the connection's writer task.
#[derive(Debug)]
pub struct OutboxRx {
    rx: mpsc::Receiver<Outbound>,
    queued: Arc<AtomicUsize>,
    dead: Arc<AtomicBool>,
}

/// A new outbox pair for a connection.
pub fn channel() -> (Outbox, OutboxRx) {
    let (tx, rx) = mpsc::channel(OUTBOX_FRAMES);
    let queued = Arc::new(AtomicUsize::new(0));
    let dead = Arc::new(AtomicBool::new(false));
    (
        Outbox {
            tx,
            queued: queued.clone(),
            dead: dead.clone(),
        },
        OutboxRx { rx, queued, dead },
    )
}

impl Outbox {
    /// Queues a text frame. False (and the outbox is dead) if it would push the queue past the limit or the channel is full.
    pub fn send_text(&self, frame: &Utf8Bytes) -> bool {
        if self.is_dead() {
            return false;
        }
        let len = frame.len();
        let queued = self.queued.fetch_add(len, Ordering::AcqRel).saturating_add(len);
        if queued > BACKPRESSURE_LIMIT || self.tx.try_send(Outbound::Text(frame.clone())).is_err() {
            self.dead.store(true, Ordering::Release);
            return false;
        }
        true
    }

    /// Queues a close frame (not counted toward the byte limit). False if the channel is full or gone.
    pub fn send_close(&self, code: u16, reason: &'static str) -> bool {
        if self.is_dead() {
            return false;
        }
        if self.tx.try_send(Outbound::Close(code, reason)).is_err() {
            self.dead.store(true, Ordering::Release);
            return false;
        }
        true
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    /// Bytes of text frames queued and not yet taken by the writer.
    pub fn queued_bytes(&self) -> usize {
        self.queued.load(Ordering::Acquire)
    }
}

impl OutboxRx {
    /// The next frame, or `None` when the connection must end without another frame: the outbox was
    /// marked dead (the queue is discarded), or the room dropped it and the queue is empty.
    pub async fn recv(&mut self) -> Option<Outbound> {
        let next = self.rx.recv().await?;
        if self.is_dead() {
            return None;
        }
        if let Outbound::Text(t) = &next {
            self.queued.fetch_sub(t.len(), Ordering::AcqRel);
        }
        Some(next)
    }

    pub fn is_dead(&self) -> bool {
        self.dead.load(Ordering::Acquire)
    }

    /// A queued frame if there is one right now (tests, and a writer draining before it closes).
    pub fn try_recv(&mut self) -> Option<Outbound> {
        let next = self.rx.try_recv().ok()?;
        if self.is_dead() {
            return None;
        }
        if let Outbound::Text(t) = &next {
            self.queued.fetch_sub(t.len(), Ordering::AcqRel);
        }
        Some(next)
    }
}

/// The connections of one room, in attach order: every open socket (so a removal can close them all), and
/// which of them are subscribed to the room's topic (joined members).
#[derive(Debug, Default)]
pub struct Subscribers {
    entries: Vec<Entry>,
}

#[derive(Debug)]
struct Entry {
    conn: ConnId,
    outbox: Outbox,
    subscribed: bool,
}

impl Subscribers {
    /// A socket opened on the room (not yet subscribed).
    pub fn attach(&mut self, conn: ConnId, outbox: Outbox) {
        self.entries.push(Entry {
            conn,
            outbox,
            subscribed: false,
        });
    }

    /// `ws.subscribe(topic)`: false for an unknown connection.
    pub fn subscribe(&mut self, conn: ConnId) -> bool {
        self.set_subscribed(conn, true)
    }

    /// `ws.unsubscribe(topic)`: false for an unknown connection.
    pub fn unsubscribe(&mut self, conn: ConnId) -> bool {
        self.set_subscribed(conn, false)
    }

    fn set_subscribed(&mut self, conn: ConnId, subscribed: bool) -> bool {
        self.entries
            .iter_mut()
            .find(|e| e.conn == conn)
            .map(|e| e.subscribed = subscribed)
            .is_some()
    }

    /// The socket closed. False if it was not attached (a dead outbox is detached by publish).
    pub fn detach(&mut self, conn: ConnId) -> bool {
        let before = self.entries.len();
        self.entries.retain(|e| e.conn != conn);
        self.entries.len() != before
    }

    pub fn is_attached(&self, conn: ConnId) -> bool {
        self.entries.iter().any(|e| e.conn == conn)
    }

    /// Connections attached, subscribed or not.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Connections subscribed to the topic.
    pub fn subscribed(&self) -> usize {
        self.entries.iter().filter(|e| e.subscribed).count()
    }

    /// One pass; a subscriber that went dead is dropped from the room (its writer ends the connection).
    fn publish(&mut self, except: Option<ConnId>, frame: &Utf8Bytes) {
        self.entries
            .retain(|e| !e.subscribed || Some(e.conn) == except || e.outbox.send_text(frame));
    }

    fn send_to(&mut self, conn: ConnId, frame: &Utf8Bytes) -> bool {
        let Some(i) = self.entries.iter().position(|e| e.conn == conn) else {
            return false;
        };
        let sent = self.entries.get(i).is_some_and(|e| e.outbox.send_text(frame));
        if !sent {
            self.entries.remove(i);
        }
        sent
    }

    /// How many close frames were queued.
    fn close_all(&mut self, code: u16, reason: &'static str) -> usize {
        let mut sent = 0;
        self.entries.retain(|e| {
            let queued = e.outbox.send_close(code, reason);
            sent += usize::from(queued);
            queued
        });
        sent
    }
}

/// `server.publish(topic, frame)`: every subscriber.
pub fn publish_all(inner: &mut RoomInner, frame: &Utf8Bytes) {
    inner.subscribers.publish(None, frame);
}

/// `ws.publish(topic, frame)`: every subscriber except `conn`.
pub fn publish_except(inner: &mut RoomInner, conn: ConnId, frame: &Utf8Bytes) {
    inner.subscribers.publish(Some(conn), frame);
}

/// Encodes `msg` once and publishes it to every subscriber (`server.publish(topic, JSON.stringify(msg))`).
/// False, and nothing is encoded, when the room has no subscriber.
pub fn publish_msg(inner: &mut RoomInner, msg: &ServerMessage) -> bool {
    if let Some(frame) = encode_frame(msg) {
        publish_all(inner, &frame);
    }
    true
}

/// `ws.send(frame)`: to one connection, subscribed or not. False if it is gone or went dead.
pub fn send_to(inner: &mut RoomInner, conn: ConnId, frame: &Utf8Bytes) -> bool {
    inner.subscribers.send_to(conn, frame)
}

/// A close frame to every attached connection, joined or not; returns how many were queued (for the close metrics).
pub fn close_all(inner: &mut RoomInner, code: u16, reason: &'static str) -> usize {
    inner.subscribers.close_all(code, reason)
}

/// A message as the frame every subscriber gets, serialized once; `None` (logged) if it can't be encoded.
pub fn encode_frame(msg: &ServerMessage) -> Option<Utf8Bytes> {
    match encode(msg) {
        Ok(json) => Some(Utf8Bytes::from(json)),
        Err(err) => {
            log_error(LogEvent::Encode, Some(&err));
            None
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use crate::registry::testing::inner;

    fn frame(s: &str) -> Utf8Bytes {
        Utf8Bytes::from(s.to_owned())
    }

    fn text(o: Outbound) -> String {
        match o {
            Outbound::Text(t) => t.as_str().to_owned(),
            Outbound::Close(c, r) => panic!("close {c} {r}"),
        }
    }

    /// A room with `n` subscribed connections, each with its receiver.
    fn room_with(n: u64) -> (RoomInner, Vec<(ConnId, OutboxRx)>) {
        let mut inner = inner();
        let mut rxs = Vec::new();
        for i in 1..=n {
            let (tx, rx) = channel();
            let conn = ConnId(i);
            inner.subscribers.attach(conn, tx);
            assert!(inner.subscribers.subscribe(conn));
            rxs.push((conn, rx));
        }
        (inner, rxs)
    }

    #[tokio::test]
    async fn publish_all_reaches_every_subscriber_in_order() {
        let (mut inner, mut rxs) = room_with(3);
        publish_all(&mut inner, &frame("a"));
        publish_all(&mut inner, &frame("b"));
        for (_, rx) in &mut rxs {
            assert_eq!(text(rx.recv().await.unwrap()), "a");
            assert_eq!(text(rx.recv().await.unwrap()), "b");
        }
    }

    // apps/server/src/ws.ts: `ws.publish` reaches every subscriber except the sender
    #[tokio::test]
    async fn publish_except_skips_the_sender_only() {
        let (mut inner, mut rxs) = room_with(3);
        publish_except(&mut inner, ConnId(2), &frame("x"));
        let (_, second) = &mut rxs[1];
        assert!(second.rx.try_recv().is_err());
        for i in [0, 2] {
            assert_eq!(text(rxs[i].1.recv().await.unwrap()), "x");
        }
    }

    #[tokio::test]
    async fn only_subscribed_connections_hear_the_topic_but_send_to_reaches_any() {
        let (mut inner, mut rxs) = room_with(1);
        let (tx, mut lurker) = channel();
        inner.subscribers.attach(ConnId(9), tx);
        publish_all(&mut inner, &frame("topic"));
        assert!(lurker.rx.try_recv().is_err());
        assert!(send_to(&mut inner, ConnId(9), &frame("direct")));
        assert_eq!(text(lurker.recv().await.unwrap()), "direct");
        assert!(!send_to(&mut inner, ConnId(77), &frame("nobody")));
        assert_eq!(text(rxs[0].1.recv().await.unwrap()), "topic");
        assert_eq!(inner.subscribers.len(), 2);
        assert_eq!(inner.subscribers.subscribed(), 1);
        assert!(inner.subscribers.unsubscribe(ConnId(1)));
        assert_eq!(inner.subscribers.subscribed(), 0);
        assert!(!inner.subscribers.subscribe(ConnId(77)));
    }

    #[tokio::test]
    async fn one_serialization_is_shared_by_every_subscriber() {
        let (mut inner, mut rxs) = room_with(2);
        let f = frame("shared");
        publish_all(&mut inner, &f);
        let a = text(rxs[0].1.recv().await.unwrap());
        let Outbound::Text(b) = rxs[1].1.recv().await.unwrap() else {
            panic!()
        };
        assert_eq!(a, "shared");
        assert_eq!(b.as_str().as_ptr(), f.as_str().as_ptr(), "a refcount clone, not a copy");
    }

    // apps/server/src/ws-limits.ts BACKPRESSURE_LIMIT, ws.ts closeOnBackpressureLimit
    #[tokio::test]
    async fn past_the_byte_limit_the_outbox_is_dead_and_the_connection_ends_without_a_close_frame() {
        let (mut inner, mut rxs) = room_with(2);
        let big = frame(&"x".repeat(BACKPRESSURE_LIMIT));
        publish_all(&mut inner, &big);
        // The slow one (index 0) never reads; the next frame crosses the limit for it only.
        let mut it = rxs.iter_mut();
        let (_, slow) = it.next().unwrap();
        let (_, fast) = it.next().unwrap();
        assert_eq!(text(fast.recv().await.unwrap()).len(), BACKPRESSURE_LIMIT);
        publish_all(&mut inner, &frame("y"));
        assert!(!inner.subscribers.is_attached(ConnId(1)), "dropped from the room");
        assert!(inner.subscribers.is_attached(ConnId(2)));
        assert!(slow.is_dead());
        assert!(slow.recv().await.is_none(), "no frame, no close frame: 1006");
        assert_eq!(text(fast.recv().await.unwrap()), "y");
    }

    #[tokio::test]
    async fn exactly_the_limit_is_allowed_and_reading_frees_the_budget() {
        let (tx, mut rx) = channel();
        let big = frame(&"x".repeat(BACKPRESSURE_LIMIT));
        assert!(tx.send_text(&big));
        assert_eq!(tx.queued_bytes(), BACKPRESSURE_LIMIT);
        assert!(!tx.is_dead());
        rx.recv().await.unwrap();
        assert_eq!(tx.queued_bytes(), 0);
        assert!(tx.send_text(&big));
        assert!(!tx.send_text(&frame("!")), "one byte over");
        assert!(tx.is_dead());
    }

    #[tokio::test]
    async fn a_full_channel_is_dead_too() {
        let (tx, _rx) = channel();
        for _ in 0..OUTBOX_FRAMES {
            assert!(tx.send_text(&frame("")));
        }
        assert!(!tx.send_text(&frame("")));
        assert!(tx.is_dead());
    }

    #[tokio::test]
    async fn publishing_never_blocks_on_a_stuck_subscriber() {
        // A current-thread runtime: if publish awaited anything the test would hang instead of finishing.
        let (mut inner, _rxs) = room_with(1);
        for _ in 0..OUTBOX_FRAMES + 10 {
            publish_all(&mut inner, &frame("tick"));
        }
        assert_eq!(inner.subscribers.len(), 0);
    }

    #[tokio::test]
    async fn close_all_reaches_joined_and_unjoined_and_the_writer_ends_after_it() {
        let (mut inner, mut rxs) = room_with(1);
        let (tx, mut lurker) = channel();
        inner.subscribers.attach(ConnId(9), tx);
        assert_eq!(close_all(&mut inner, 4004, "room closed"), 2);
        for rx in [&mut rxs[0].1, &mut lurker] {
            let Outbound::Close(code, reason) = rx.recv().await.unwrap() else {
                panic!()
            };
            assert_eq!((code, reason), (4004, "room closed"));
        }
    }

    #[tokio::test]
    async fn detaching_ends_the_queue_after_what_is_already_in_it() {
        let (mut inner, mut rxs) = room_with(1);
        publish_all(&mut inner, &frame("last words"));
        assert!(inner.subscribers.detach(ConnId(1)));
        assert!(!inner.subscribers.detach(ConnId(1)));
        let rx = &mut rxs[0].1;
        assert_eq!(text(rx.recv().await.unwrap()), "last words");
        assert!(rx.recv().await.is_none());
    }

    #[test]
    fn publish_msg_skips_the_encode_when_nobody_is_subscribed() {
        use crate::contract::server_message::ServerMessage;
        let mut empty = inner();
        assert!(!publish_msg(&mut empty, &ServerMessage::RoomFull {}));
        let (mut with, mut rxs) = room_with(1);
        assert!(publish_msg(&mut with, &ServerMessage::RoomFull {}));
        assert!(rxs[0].1.try_recv().is_some());
        // Attached but not subscribed is nobody either.
        let (tx, _rx) = channel();
        empty.subscribers.attach(ConnId(5), tx);
        assert!(!publish_msg(&mut empty, &ServerMessage::RoomFull {}));
    }

    #[test]
    fn conn_ids_are_unique() {
        assert_ne!(ConnId::next(), ConnId::next());
    }

    #[test]
    fn a_message_is_encoded_to_its_json_frame() {
        use crate::contract::server_message::ServerMessage;
        let msg = ServerMessage::RoomFull {};
        assert_eq!(encode_frame(&msg).unwrap().as_str(), r#"{"type":"room-full"}"#);
    }
}
