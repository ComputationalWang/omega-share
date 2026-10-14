//! The `serve` command: config → listener → router, until SIGTERM/SIGINT.

use crate::config::ServerConfig;
use crate::log::{stderr_line, stdout_line};
use axum::Router;
use axum::http::StatusCode;
use tokio::net::TcpListener;

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
    axum::serve(listener, app).with_graceful_shutdown(shutdown_signal()).await
}

/// SIGTERM (systemd `restart`/`stop`) or SIGINT. If a handler can't be installed, that signal just
/// keeps its default action.
async fn shutdown_signal() {
    let interrupt = tokio::signal::ctrl_c();
    let mut term = match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
        Ok(term) => Some(term),
        Err(err) => {
            stderr_line(&format!("SIGTERM handler: {err}"));
            None
        }
    };
    let terminate = async {
        match term.as_mut() {
            Some(term) => {
                term.recv().await;
            }
            None => std::future::pending::<()>().await,
        }
    };
    tokio::select! {
        _ = interrupt => {}
        () = terminate => {}
    }
}
