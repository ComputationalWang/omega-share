//! The frames and closes the relay sends to one connection or to the room's other members, in one place so
//! every close is counted in the metrics and every error has the shape ws.ts gives it.

use crate::app::App;
use crate::contract::server_message::{ErrorCode, ErrorMessage, RetryAfterMs, ServerMessage};
use crate::outbox::{ConnId, close_conn, encode_frame, publish_frame, send_to};
use crate::registry::RoomInner;

/// `sendError`: `{type:"error", code, message}` to one connection.
pub fn send_error(inner: &mut RoomInner, conn: ConnId, code: ErrorCode, message: &str) {
    send_error_after(inner, conn, code, message, None);
}

/// A `rate_limited` error (or any other) with the time to wait, to one connection.
pub fn send_error_after(inner: &mut RoomInner, conn: ConnId, code: ErrorCode, message: &str, retry_after_ms: Option<f64>) {
    let Some(message) = ErrorMessage::new(message) else { return };
    // `retryAfterMs` is an integer, capped like the schema.
    let retry_after_ms = retry_after_ms.and_then(|ms| RetryAfterMs::new(ms.max(0.0).ceil().min(60_000.0) as u64));
    let msg = ServerMessage::Error {
        code,
        message,
        retry_after_ms,
    };
    if let Some(frame) = encode_frame(&msg) {
        send_to(inner, conn, &frame);
    }
}

/// `ws.send(encode(msg))`.
pub fn send_msg(inner: &mut RoomInner, conn: ConnId, msg: &ServerMessage) {
    if let Some(frame) = encode_frame(msg) {
        send_to(inner, conn, &frame);
    }
}

/// `ws.publish(topic, encode(msg))`: everyone subscribed but `conn`.
pub fn publish_except_msg(inner: &mut RoomInner, conn: ConnId, msg: &ServerMessage) {
    if inner.subscribers.subscribed() == 0 {
        return;
    }
    if let Some(frame) = encode_frame(msg) {
        publish_frame(inner, Some(conn), msg, &frame);
    }
}

/// `closeWith`: every close the server sends goes through here, so `GET /metrics` counts it.
pub fn close_with(app: &App, inner: &mut RoomInner, conn: ConnId, code: u16, reason: &'static str) {
    if close_conn(inner, conn, code, reason) {
        app.metrics.count_close(code);
    }
}
