//! The `serve` command: config → listener → router, until SIGTERM/SIGINT.

use crate::app::{App, BootError};
use crate::clock::SharedClock;
use crate::config::ServerConfig;
use crate::log::stdout_line;
use crate::rooms_gc::spawn_room_gc;
use axum::Router;
use axum::http::StatusCode;
use std::future::IntoFuture;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::sync::watch;

/// How long a shutdown waits for open connections before cutting them off (`DRAIN_GRACE_MS` in
/// apps/server/src/server.ts), so a stalled client can't hold a restart until systemd's SIGKILL.
const DRAIN_GRACE: Duration = Duration::from_millis(3000);

/// Why `serve` stopped with an error: the app could not start, or the listener failed.
#[derive(Debug)]
pub enum ServeError {
    /// Printed as it is (`DB_PATH <path>: <message>`, or the corrupt row's room): nothing was served.
    Boot(BootError),
    Io(std::io::Error),
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Boot(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "serve: {e}"),
        }
    }
}

impl std::error::Error for ServeError {}

impl From<std::io::Error> for ServeError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Boots the app (database, rooms, seat holds, the boot GC sweep), binds and serves until a shutdown signal.
/// Errors before listening are returned, not panicked.
pub async fn serve(config: ServerConfig) -> Result<(), ServeError> {
    let (clock, hooks) = clock_and_hooks();
    let app = App::boot(config.clone(), clock).map_err(ServeError::Boot)?;
    let gc = spawn_room_gc(app.clone());
    let served = listen(config, app, hooks).await;
    gc.abort();
    served
}

/// The clock the app runs on, and the routes that drive it: the system clock and none in a normal build; the
/// virtual clock and `/__test/time` with the `test-hooks` feature (ADR 0050), so the black-box suite moves time.
fn clock_and_hooks() -> (SharedClock, Router) {
    #[cfg(feature = "test-hooks")]
    return crate::test_hooks::install();
    #[cfg(not(feature = "test-hooks"))]
    (crate::clock::SystemClock::shared(), Router::new())
}

async fn listen(config: ServerConfig, app: Arc<App>, hooks: Router) -> Result<(), ServeError> {
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
    // Each slice builds its routes in its own file; the fallback goes last.
    let router = Router::new()
        .merge(hooks)
        .merge(crate::http::router(app.clone()))
        .merge(crate::ws::router(app.clone()))
        .fallback(|| async { (StatusCode::NOT_FOUND, "not found") });

    let (stop, mut stopped) = watch::channel(false);
    let serving = axum::serve(listener, router).with_graceful_shutdown(async move {
        // Resolves on the stop signal, or if the sender is gone (nothing left to wait for).
        let _ = stopped.wait_for(|stop| *stop).await;
    });
    let mut serving = std::pin::pin!(serving.into_future());
    tokio::select! {
        served = &mut serving => return served.map_err(ServeError::Io),
        () = shutdown_signal() => {}
    }
    // Stop accepting, let in-flight requests finish, but only for so long.
    let _ = stop.send(true);
    match tokio::time::timeout(DRAIN_GRACE, serving).await {
        Ok(served) => served.map_err(ServeError::Io),
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
