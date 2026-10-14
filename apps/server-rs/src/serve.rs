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

/// The black-box wiring: the clock `serve` boots the app with is the one `/__test/time` moves.
#[cfg(all(test, feature = "test-hooks"))]
#[allow(clippy::unwrap_used, reason = "tests")]
mod wiring_tests {
    use super::*;
    use crate::app::testing::{add_room, config, rid};
    use crate::room::RoomInit;
    use crate::store::Store;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn http(addr: std::net::SocketAddr, request: String) -> String {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    const ID: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaa";
    const MIN: i64 = 60_000;

    #[tokio::test(flavor = "current_thread")]
    async fn a_time_set_fires_the_room_gc_timer_the_app_armed() {
        let (clock, hooks) = clock_and_hooks();
        let app = Arc::new(App::new(config(&[]), clock.clone(), Store::open(":memory:").unwrap()).unwrap());
        let created = clock.wall_ms();
        add_room(
            &app,
            ID,
            RoomInit {
                pinned: Some(false),
                created_at: Some(created),
                ..RoomInit::default()
            },
        );
        let gc = spawn_room_gc(app.clone());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, hooks).await });
        tokio::task::yield_now().await;
        let get = "GET /__test/time HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n".to_owned();
        assert!(http(addr, get).await.ends_with(r#"{"pending":1}"#), "the GC loop armed one timer");
        assert!(app.registry.get(&rid(ID)).is_some());

        let body = format!(
            r#"{{"mono":{},"wall":{}}}"#,
            clock.mono_ms() + (21 * MIN) as f64,
            created + 21 * MIN
        );
        let post = format!(
            "POST /__test/time HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        assert!(http(addr, post).await.ends_with(r#"{"fired":1}"#));
        // No settling here: the reply means the sweep has run.
        assert!(
            app.registry.get(&rid(ID)).is_none(),
            "the sweep removed the idle room before the reply"
        );
        gc.abort();
    }
}
