//! Time, injected: the TS server's `now` (performance.now), `wallNow` (Date.now) and `schedule`
//! options in one seam. Production uses [`SystemClock`]; the `test-hooks` build swaps in a virtual
//! clock the black-box suite drives (ADR 0050), so nothing outside this module reads the system time.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub type Sleep = Pin<Box<dyn Future<Output = ()> + Send>>;

pub trait Clock: Send + Sync {
    /// Monotonic milliseconds, fractional (`performance.now()`): limiters, debounces, timeouts.
    fn mono_ms(&self) -> f64;
    /// Unix milliseconds (`Date.now()`): `created_at`, `last_active_at`, room GC, seat holds.
    fn wall_ms(&self) -> i64;
    /// Resolves once `ms` have passed on this clock (`schedule`): grace holds, timeouts.
    fn sleep(&self, ms: f64) -> Sleep;
}

pub type SharedClock = Arc<dyn Clock>;

pub struct SystemClock {
    start: Instant,
}

impl SystemClock {
    pub fn shared() -> SharedClock {
        Arc::new(Self { start: Instant::now() })
    }
}

impl Clock for SystemClock {
    fn mono_ms(&self) -> f64 {
        self.start.elapsed().as_secs_f64() * 1000.0
    }

    fn wall_ms(&self) -> i64 {
        // A clock before 1970 reads as 1970; the epoch math can't fail otherwise.
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
    }

    fn sleep(&self, ms: f64) -> Sleep {
        // Negative, NaN or absurd delays clamp instead of panicking in Duration.
        let delay = Duration::try_from_secs_f64(ms.max(0.0) / 1000.0).unwrap_or(Duration::MAX);
        Box::pin(tokio::time::sleep(delay))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn system_time_moves_forward_and_sleeps() {
        let clock = SystemClock::shared();
        let before = clock.mono_ms();
        clock.sleep(5.0).await;
        assert!(clock.mono_ms() >= before + 5.0);
        assert!(clock.wall_ms() > 1_700_000_000_000);
        // A NaN delay must not panic.
        clock.sleep(f64::NAN).await;
    }
}
