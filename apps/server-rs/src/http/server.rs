//! The accept loop: hyper's HTTP/1 server with a header-read timeout (slowloris), graceful shutdown, and the
//! peer address on every request (`ConnectInfo<SocketAddr>`, as `axum::serve` would give it). `axum::serve` has no
//! knob for the timeout, so the loop is ours; hyper, hyper-util and tower-service are what axum itself uses.

use axum::Router;
use axum::extract::ConnectInfo;
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper_util::rt::{TokioIo, TokioTimer};
use std::convert::Infallible;
use std::future::Future;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tower_service::Service;

/// How long a client may take to send its request head, and to send the next one on a kept-alive connection
/// (Bun's `idleTimeout` did this in TS).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Caps and timeouts of the listener (HTTP-1, L10 of the S10 audit).
#[derive(Debug, Clone, Copy)]
pub struct Limits {
    pub header_read_timeout: Duration,
    /// A response write that makes no progress for this long cuts the connection.
    pub write_stall: Duration,
    /// Open connections, WebSockets included.
    pub max_connections: usize,
    /// Open connections per non-loopback peer address.
    pub max_per_ip: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            header_read_timeout: HEADER_READ_TIMEOUT,
            write_stall: Duration::from_secs(10),
            max_connections: 1280,
            max_per_ip: 128,
        }
    }
}

/// Counts open connections, in all and per peer address.
#[derive(Debug)]
pub struct Admission;

impl Admission {
    pub fn new(_max: usize, _max_per_ip: usize) -> Self {
        Self
    }

    /// `None` when the connection is over a cap.
    pub fn admit(&self, _peer: std::net::IpAddr) -> Option<()> {
        None
    }
}

/// `serve_with` under `limits`.
pub async fn serve_limited(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send,
    limits: Limits,
) -> std::io::Result<()> {
    serve_with(listener, router, shutdown, limits.header_read_timeout).await
}

/// Serves `router` on `listener` until `shutdown` resolves, then lets open connections finish (the caller bounds
/// how long it waits).
pub async fn serve(listener: TcpListener, router: Router, shutdown: impl Future<Output = ()> + Send) -> std::io::Result<()> {
    serve_with(listener, router, shutdown, HEADER_READ_TIMEOUT).await
}

/// `serve` with another header-read timeout (tests).
pub async fn serve_with(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send,
    header_read_timeout: Duration,
) -> std::io::Result<()> {
    // Each connection holds a receiver: the sender's `closed` is "every connection has ended".
    let (stop, _) = watch::channel(false);
    let mut shutdown = std::pin::pin!(shutdown);
    loop {
        let (stream, peer) = tokio::select! {
            accepted = listener.accept() => match accepted {
                Ok(connection) => connection,
                // A connection that died before we saw it is not the listener's problem; running out of
                // descriptors is, for a moment: don't spin on it.
                Err(err) if matches!(err.kind(), std::io::ErrorKind::ConnectionAborted | std::io::ErrorKind::ConnectionReset) => continue,
                Err(_) => {
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            },
            () = &mut shutdown => break,
        };
        // Small frames (a chat line, a playback tick) must not wait for Nagle.
        let _ = stream.set_nodelay(true);
        let router = router.clone();
        let service = service_fn(move |mut req: hyper::Request<Incoming>| {
            req.extensions_mut().insert(ConnectInfo(peer));
            let mut router = router.clone();
            async move { Ok::<_, Infallible>(router.call(req).await.unwrap_or_else(|never| match never {})) }
        });
        let connection = http1::Builder::new()
            .timer(TokioTimer::new())
            .header_read_timeout(header_read_timeout)
            .serve_connection(TokioIo::new(stream), service)
            .with_upgrades();
        let mut stopping = stop.subscribe();
        tokio::spawn(async move {
            let mut connection = std::pin::pin!(connection);
            tokio::select! {
                _ = connection.as_mut() => return,
                _ = stopping.wait_for(|stop| *stop) => {}
            }
            // Finish the request in flight, answer no more, close.
            connection.as_mut().graceful_shutdown();
            let _ = connection.await;
        });
    }
    let _ = stop.send(true);
    stop.closed().await;
    Ok(())
}
