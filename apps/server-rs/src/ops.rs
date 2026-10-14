//! S7 (operations): the admin socket and CLI (`admin.rs`, `cli.rs`), backup (`backup.rs`), the metrics listener
//! (`metrics_server.rs`) and the graceful restart (`shutdown.rs`). S7 owns this file; `App` and `serve.rs` need no
//! edit for it beyond the shutdown wiring (it serves no routes on the public router).

use std::time::Instant;

/// State S7 keeps on the app: when the process started (`process_uptime_seconds`). The admin socket and the
/// metrics listener are tasks `serve` owns for the length of the run.
#[derive(Debug)]
pub struct OpsState {
    started: Instant,
}

impl Default for OpsState {
    fn default() -> Self {
        Self { started: Instant::now() }
    }
}

impl OpsState {
    /// Seconds since the app was built (the process's start, for the binary).
    pub fn uptime_seconds(&self) -> f64 {
        self.started.elapsed().as_secs_f64()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // apps/server/test/metrics.test.ts:62
    #[test]
    fn uptime_is_positive_and_grows() {
        let ops = OpsState::default();
        let first = ops.uptime_seconds();
        std::thread::sleep(std::time::Duration::from_millis(5));
        assert!(first >= 0.0 && ops.uptime_seconds() > first);
    }
}
