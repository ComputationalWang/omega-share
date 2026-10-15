//! Reading a request body under a cap, while it arrives (`readBodyCapped`, rate-limit.ts): a body past the cap is
//! never buffered past it, and a client that stops sending is cut off (Bun's `idleTimeout`).

use axum::body::Body;
use axum::http::HeaderMap;
use axum::http::header::CONTENT_LENGTH;
use http_body_util::BodyExt;
use std::time::Duration;

/// How long a body may stall between two frames.
pub const BODY_IDLE_TIMEOUT: Duration = Duration::from_secs(10);

/// Why a body was not read.
#[derive(Debug, PartialEq, Eq)]
pub enum BodyError {
    /// More than the cap: answer 413.
    TooLarge,
    /// The client went away, stalled, or sent a malformed stream: answered like a body that is not JSON.
    Failed,
}

/// `Number(content-length ?? 0) > max`: the check before any byte is read. hyper has already refused a header
/// that is not a number.
pub fn declared_too_large(headers: &HeaderMap, max: usize) -> bool {
    headers
        .get(CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.trim().parse::<u64>().map_or(true, |n| n > u64::try_from(max).unwrap_or(u64::MAX)))
}

/// The body's bytes, or `TooLarge` as soon as they exceed `max`.
pub async fn read_capped(body: Body, max: usize, total: Duration) -> Result<Vec<u8>, BodyError> {
    // One deadline for the whole body: a client trickling a byte per stall timeout would hold its in-flight slot forever.
    tokio::time::timeout(total, read_capped_within(body, max, BODY_IDLE_TIMEOUT))
        .await
        .unwrap_or(Err(BodyError::Failed))
}

pub async fn read_capped_within(mut body: Body, max: usize, idle: Duration) -> Result<Vec<u8>, BodyError> {
    let mut out = Vec::new();
    loop {
        let frame = tokio::time::timeout(idle, body.frame()).await.map_err(|_| BodyError::Failed)?;
        match frame {
            None => return Ok(out),
            Some(Err(_)) => return Err(BodyError::Failed),
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data() {
                    if out.len().saturating_add(data.len()) > max {
                        return Err(BodyError::TooLarge);
                    }
                    out.extend_from_slice(&data);
                }
            }
        }
    }
}
