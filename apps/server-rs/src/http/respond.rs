//! Response builders: the exact content types and bodies of the TS server (Hono's `c.json`/`c.text`/`c.html` and
//! Bun's `new Response(text)`), and the typed error bodies of `contract::responses`.

use crate::contract::responses::{ErrorBody, Response as Typed, to_body};
use crate::contract::server_message::{ErrorMessage, RetryAfter};
use axum::body::Body;
use axum::http::header::{CONNECTION, CONTENT_TYPE, RETRY_AFTER};
use axum::http::{HeaderValue, StatusCode};
use axum::response::Response;
use serde::Serialize;

/// Hono's `c.text`.
pub const TEXT: &str = "text/plain; charset=UTF-8";
/// Bun's `new Response(string)`: what `plain()` in http.ts sends.
pub const PLAIN: &str = "text/plain;charset=utf-8";
/// Hono's `c.html`.
pub const HTML: &str = "text/html; charset=UTF-8";
pub const JSON: &str = "application/json";

pub fn with_type(status: StatusCode, content_type: &'static str, body: impl Into<Body>) -> Response {
    let mut res = Response::new(body.into());
    *res.status_mut() = status;
    res.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static(content_type));
    res
}

/// Bun's `plain(status, text)`: refusals from the gate.
pub fn plain(status: StatusCode, text: &'static str) -> Response {
    with_type(status, PLAIN, text)
}

/// Hono's `c.text(text, status)`, and the default 404.
pub fn text(status: StatusCode, text: &'static str) -> Response {
    with_type(status, TEXT, text)
}

pub fn not_found() -> Response {
    text(StatusCode::NOT_FOUND, "404 Not Found")
}

/// Hono's default error handler.
pub fn internal_error() -> Response {
    text(StatusCode::INTERNAL_SERVER_ERROR, "Internal Server Error")
}

/// `c.json(body, status)`.
pub fn json<T: Serialize>(status: StatusCode, body: &T) -> Response {
    match to_body(body) {
        Ok(text) => with_type(status, JSON, text),
        Err(_) => internal_error(),
    }
}

/// `retry-after`: whole seconds, at least 1.
pub fn retry_after(res: &mut Response, ms: u64) {
    let secs = ms.div_ceil(1000).max(1);
    if let Ok(value) = HeaderValue::from_str(&secs.to_string()) {
        res.headers_mut().insert(RETRY_AFTER, value);
    }
}

/// `{ ok: false, error: { code, message, retryAfterMs? } }` with `status`; `retry_ms` also sets `Retry-After`.
pub fn failure<T: Serialize, C: Serialize, const MAX: u64>(status: StatusCode, code: C, message: &str, retry_ms: Option<u64>) -> Response {
    let Some(message) = ErrorMessage::new(message) else {
        return internal_error();
    };
    let retry_ms = retry_ms.map(|ms| ms.min(MAX));
    let retry_after_ms = retry_ms.and_then(RetryAfter::<MAX>::new);
    let body: Typed<T, C, MAX> = Typed::Err(ErrorBody {
        code,
        message,
        retry_after_ms,
    });
    let mut res = json(status, &body);
    // The oversized body is left unread, so the connection ends after this answer: say so, or a keep-alive client reuses it.
    if status == StatusCode::PAYLOAD_TOO_LARGE {
        res.headers_mut().insert(CONNECTION, HeaderValue::from_static("close"));
    }
    if let Some(ms) = retry_ms {
        retry_after(&mut res, ms);
    }
    res
}
