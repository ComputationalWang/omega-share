//! The `serve` command: config → listener → router, until SIGTERM/SIGINT, then the graceful restart.

use crate::admin::start_admin;
use crate::app::{App, BootError};
use crate::clock::SharedClock;
use crate::config::ServerConfig;
use crate::log::{LogEvent, log_error, stderr_line, stdout_line};
use crate::metrics_server::start_metrics;
use crate::rooms_gc::spawn_room_gc;
use crate::shutdown;
use crate::store::SeatHold;
use axum::Router;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tokio::net::TcpListener;
use tokio::signal::unix::{Signal, SignalKind, signal};
use tokio::sync::watch;

/// How long a shutdown waits for open connections before cutting them off (`DRAIN_GRACE_MS` in
/// apps/server/src/server.ts), so a stalled client can't hold a restart until systemd's SIGKILL.
const DRAIN_GRACE: Duration = Duration::from_millis(3000);
/// Open sockets beyond `MAX_CONNECTIONS` that plain HTTP may use (each response can hold one file too).
const HTTP_HEADROOM: usize = 256;

/// Why `serve` stopped with an error: the app could not start, or the listener failed.
#[derive(Debug)]
pub enum ServeError {
    /// Printed as it is (`DB_PATH <path>: <message>`, or the corrupt row's room): nothing was served.
    Boot(BootError),
    Io(std::io::Error),
    /// The shutdown failed and logged why (`shutdown`): exit 1, nothing more to print.
    Logged,
}

impl std::fmt::Display for ServeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Boot(e) => write!(f, "{e}"),
            Self::Io(e) => write!(f, "serve: {e}"),
            Self::Logged => Ok(()),
        }
    }
}

impl std::error::Error for ServeError {}

impl From<std::io::Error> for ServeError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Boots the app (database, rooms, seat holds, the boot GC sweep), binds and serves until a shutdown signal, then
/// runs the graceful restart (index.ts `shutdown`). `admin_socket` is where the operator CLI listens, if anywhere.
/// Errors before listening are returned, not panicked.
pub async fn serve(config: ServerConfig, admin_socket: Option<PathBuf>) -> Result<(), ServeError> {
    // Installed first and kept to the end: a second SIGTERM or SIGINT during the shutdown must not kill it.
    let mut signals = Signals::install();
    let (clock, hooks) = clock_and_hooks();
    let app = App::boot(config.clone(), clock).map_err(ServeError::Boot)?;
    let gc = spawn_room_gc(app.clone());
    let served = listen(config, app.clone(), hooks, admin_socket, &mut signals).await;
    gc.abort();
    let holds = served?;
    // The seats are saved, the WAL folded into the main file; a failure is logged and the exit code is 1.
    shutdown::finish(&app, &holds).map_err(|err| {
        log_error(LogEvent::Shutdown, Some(&err));
        ServeError::Logged
    })
}

/// Each slice builds its routes in its own file (`hooks` are the test-hooks routes, empty in a normal build); S5's
/// gate and headers wrap the lot and answer what no route does.
pub fn build_router(app: Arc<App>, hooks: Router) -> Router {
    let routes = Router::new()
        .merge(hooks)
        .merge(crate::http::router(app.clone()))
        .merge(crate::ws::router(app.clone()));
    crate::http::wrap(app, routes)
}

/// The clock the app runs on, and the routes that drive it: the system clock and none in a normal build; the
/// virtual clock and `/__test/time` with the `test-hooks` feature (ADR 0050), so the black-box suite moves time.
fn clock_and_hooks() -> (SharedClock, Router) {
    #[cfg(feature = "test-hooks")]
    return crate::test_hooks::install();
    #[cfg(not(feature = "test-hooks"))]
    (crate::clock::SystemClock::shared(), Router::new())
}

/// Listens and serves until a signal; returns the seats to save (none if the listener itself failed).
async fn listen(
    config: ServerConfig,
    app: Arc<App>,
    hooks: Router,
    admin_socket: Option<PathBuf>,
    signals: &mut Signals,
) -> Result<Vec<SeatHold>, ServeError> {
    let listener = TcpListener::bind((config.hostname.as_str(), config.port)).await?;
    let addr = listener.local_addr()?;
    let metrics = match config.metrics_port {
        Some(port) => Some(start_metrics(app.clone(), port).await?),
        None => None,
    };
    let admin = admin_socket.and_then(|path| match start_admin(app.clone(), &path) {
        Ok(admin) => {
            stdout_line(&format!("operator CLI socket at {}", path.display()));
            Some(admin)
        }
        Err(err) => {
            // Serving the site matters more than the CLI: say so loudly, keep running.
            stderr_line(&format!("ADMIN_SOCKET {}: {err}; the operator CLI is unavailable", path.display()));
            None
        }
    });
    // Before the line below: a client that waits for it must find the allowlists in place.
    app.http.bind(&config, addr.port());
    let via = config
        .public_origin
        .as_deref()
        .map(|o| format!(", public origin {o}"))
        .unwrap_or_default();
    stdout_line(&format!(
        "omega-share server on http://{addr}/ (site origin {}{via})",
        config.site_origin
    ));
    if let Some(metrics) = &metrics {
        stdout_line(&format!("metrics on http://127.0.0.1:{}/metrics (loopback only)", metrics.port()));
    }
    let router = build_router(app.clone(), hooks);

    let (stop, mut stopped) = watch::channel(false);
    // Sockets in all: the WebSocket cap plus headroom for HTTP, so `MAX_CONNECTIONS` (at most 3072) and the files
    // behind responses stay under the unit's `LimitNOFILE=4096`.
    let limits = crate::http::server::Limits {
        max_connections: usize::try_from(config.max_connections)
            .unwrap_or(usize::MAX)
            .saturating_add(HTTP_HEADROOM),
        max_per_ip: crate::http::server::Limits::default().max_per_ip.max(
            usize::try_from(config.max_connections_per_ip.unwrap_or(0))
                .unwrap_or(0)
                .saturating_add(64),
        ),
        ..crate::http::server::Limits::default()
    };
    let serving = crate::http::server::serve_limited(
        listener,
        router,
        async move {
            // Resolves on the stop signal, or if the sender is gone (nothing left to wait for).
            let _ = stopped.wait_for(|stop| *stop).await;
        },
        limits,
    );
    let mut serving = std::pin::pin!(serving);
    let ended = tokio::select! {
        served = &mut serving => Some(served),
        () = signals.wait() => None,
    };
    let result = match ended {
        // The listener failed by itself: nothing to drain.
        Some(served) => served.map(|()| Vec::new()).map_err(ServeError::Io),
        None => {
            // Stop accepting, close every socket with SERVICE_RESTART, let in-flight requests finish, but only for so long.
            let _ = stop.send(true);
            let holds = shutdown::drain_sockets(&app);
            // Connections past the grace are cut, not awaited; a listener error now changes nothing.
            let began = tokio::time::Instant::now();
            let _ = tokio::time::timeout(DRAIN_GRACE, serving).await;
            // An upgraded socket is no longer the listener's: with shards, wait (within the same grace) for the
            // shard tasks to write their close frames and release their slots, then stop and join the threads.
            if let Some(shards) = app.ws.shards() {
                let left = DRAIN_GRACE.saturating_sub(began.elapsed());
                let _ = tokio::time::timeout(left, async {
                    while app.ws.connections() > 0 {
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                })
                .await;
                shards.stop(Duration::from_millis(100));
            }
            Ok(holds)
        }
    };
    if let Some(metrics) = metrics {
        metrics.stop();
    }
    if let Some(admin) = admin {
        admin.stop().await;
    }
    result
}

/// SIGTERM (systemd `restart`/`stop`) and SIGINT, each handled once for the whole run. A handler that can't be
/// installed never fires, so that signal keeps its default action instead of triggering a shutdown. The streams are
/// kept until `serve` returns, so a repeat signal while shutting down is swallowed, as `draining` does in index.ts.
struct Signals {
    terminate: Option<Signal>,
    interrupt: Option<Signal>,
}

impl Signals {
    fn install() -> Self {
        Self {
            terminate: signal(SignalKind::terminate()).ok(),
            interrupt: signal(SignalKind::interrupt()).ok(),
        }
    }

    /// The first signal of either kind.
    async fn wait(&mut self) {
        let terminate = async {
            match self.terminate.as_mut() {
                Some(s) => s.recv().await,
                None => std::future::pending().await,
            }
        };
        let interrupt = async {
            match self.interrupt.as_mut() {
                Some(s) => s.recv().await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            _ = terminate => {}
            _ = interrupt => {}
        }
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
