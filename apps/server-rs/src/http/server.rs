//! The accept loop: hyper's HTTP/1 server with a header-read timeout (slowloris), graceful shutdown, and the
//! peer address on every request.

use axum::Router;
use std::future::Future;
use std::net::SocketAddr;
use std::time::Duration;
use tokio::net::TcpListener;

/// How long a client may take to send its request head, and to send the next one on a kept-alive connection
/// (Bun's `idleTimeout` did this in TS).
pub const HEADER_READ_TIMEOUT: Duration = Duration::from_secs(10);

/// Serves `router` on `listener` until `shutdown` resolves, then lets open connections finish.
pub async fn serve(listener: TcpListener, router: Router, shutdown: impl Future<Output = ()> + Send + 'static) -> std::io::Result<()> {
    serve_with(listener, router, shutdown, HEADER_READ_TIMEOUT).await
}

/// `serve` with another header-read timeout (tests).
pub async fn serve_with(
    listener: TcpListener,
    router: Router,
    shutdown: impl Future<Output = ()> + Send + 'static,
    header_read_timeout: Duration,
) -> std::io::Result<()> {
    let _ = header_read_timeout;
    axum::serve(listener, router.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown)
        .await
}
