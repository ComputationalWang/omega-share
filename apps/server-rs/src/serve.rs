//! The `serve` command: config → listener → router, until SIGTERM/SIGINT.

use crate::config::ServerConfig;

/// Binds and serves until a shutdown signal. Errors before listening are returned, not panicked.
pub async fn serve(config: ServerConfig) -> std::io::Result<()> {
    Err(std::io::Error::other("not yet serving"))
}
