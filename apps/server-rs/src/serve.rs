//! The `serve` command: config → listener → router, until SIGTERM/SIGINT.

use crate::config::ServerConfig;
use crate::log::stdout_line;
use axum::Router;
use axum::http::StatusCode;
use std::future::IntoFuture;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::watch;

/// How long a shutdown waits for open connections before cutting them off (`DRAIN_GRACE_MS` in
/// apps/server/src/server.ts), so a stalled client can't hold a restart until systemd's SIGKILL.
const DRAIN_GRACE: Duration = Duration::from_millis(3000);

/// Binds and serves until a shutdown signal. Errors before listening are returned, not panicked.
pub async fn serve(config: ServerConfig) -> std::io::Result<()> {
    let listener = TcpListener::bind((config.hostname.as_str(), config.port)).await?;
    let addr = listener.local_addr()?;
    let via = config
        .public_origin
        .as_deref()
        .map(|o| format!(", public origin {o}"))
        .unwrap_or_default();
    stdout_line(&format!(
        "omega-share server on http://{addr}/ (site origin {}{via})",
        config.site_origin
    ));
    let app = Router::new().fallback(|| async { (StatusCode::NOT_FOUND, "not found") });
    // Black-box suite only (ADR 0050): a virtual clock the test drives over `/__test/time`.
    #[cfg(feature = "test-hooks")]
    let (_clock, hooks) = crate::test_hooks::install();
    #[cfg(feature = "test-hooks")]
    let app = hooks.merge(app);

    let (stop, mut stopped) = watch::channel(false);
    let serving = axum::serve(listener, app).with_graceful_shutdown(async move {
        // Resolves on the stop signal, or if the sender is gone (nothing left to wait for).
        let _ = stopped.wait_for(|stop| *stop).await;
    });
    let mut serving = std::pin::pin!(serving.into_future());
    tokio::select! {
        served = &mut serving => return served,
        () = shutdown_signal() => {}
    }
    // Stop accepting, let in-flight requests finish, but only for so long.
    let _ = stop.send(true);
    match tokio::time::timeout(DRAIN_GRACE, serving).await {
        Ok(served) => served,
        Err(_) => Ok(()),
    }
}

/// SIGTERM (systemd `restart`/`stop`) or SIGINT. A handler that can't be installed never fires,
/// so that signal keeps its default action instead of triggering a shutdown.
async fn shutdown_signal() {
    let interrupt = async {
        if tokio::signal::ctrl_c().await.is_err() {
            std::future::pending::<()>().await;
        }
    };
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut term) => {
                term.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        () = interrupt => {}
        () = terminate => {}
    }
}
