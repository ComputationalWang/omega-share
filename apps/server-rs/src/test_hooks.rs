//! Test-only control plane for the black-box suite (ADR 0050, PORTING.md "The black-box suite").
//! Compiled only with the `test-hooks` feature: a virtual clock and the `/__test/time` routes.

use crate::clock::{Clock, SharedClock, Sleep};
use axum::Router;
use std::sync::Arc;

/// A clock the test moves by hand. `sleep(ms)` resolves when virtual time reaches its deadline.
pub struct VirtualClock {}

impl VirtualClock {
    pub fn shared() -> Arc<Self> {
        Arc::new(Self {})
    }

    /// Sets both clocks and fires every timer due at or before the new monotonic time, one at a
    /// time in deadline order, waiting for each to be acknowledged. Returns how many fired.
    pub async fn set(&self, _mono: f64, _wall: i64) -> usize {
        0
    }

    /// Timers armed and not yet fired.
    pub fn pending(&self) -> usize {
        usize::MAX
    }
}

impl Clock for VirtualClock {
    fn mono_ms(&self) -> f64 {
        -1.0
    }
    fn wall_ms(&self) -> i64 {
        -1
    }
    fn sleep(&self, _ms: f64) -> Sleep {
        Box::pin(std::future::pending())
    }
}

/// The virtual clock and the router that drives it (`POST`/`GET /__test/time`).
pub fn install() -> (SharedClock, Router) {
    (VirtualClock::shared(), Router::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[tokio::test]
    async fn time_only_moves_when_set() {
        let clock = VirtualClock::shared();
        assert_eq!(clock.set(1_000.0, 5_000).await, 0);
        assert_eq!(clock.mono_ms(), 1_000.0);
        assert_eq!(clock.wall_ms(), 5_000);
    }

    #[tokio::test]
    async fn sleep_resolves_only_when_time_reaches_the_deadline() {
        let clock = VirtualClock::shared();
        clock.set(100.0, 0).await;
        let done = Arc::new(AtomicBool::new(false));
        let (c, d) = (clock.clone(), done.clone());
        tokio::spawn(async move {
            c.sleep(50.0).await;
            d.store(true, Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        assert_eq!(clock.pending(), 1);
        clock.set(149.0, 0).await;
        assert!(!done.load(Ordering::SeqCst));
        assert_eq!(clock.set(150.0, 0).await, 1);
        assert!(done.load(Ordering::SeqCst));
        assert_eq!(clock.pending(), 0);
    }

    #[tokio::test]
    async fn set_returns_after_the_woken_task_finished_its_synchronous_work() {
        let clock = VirtualClock::shared();
        let done = Arc::new(AtomicBool::new(false));
        let (c, d) = (clock.clone(), done.clone());
        tokio::spawn(async move {
            c.sleep(10.0).await;
            // Post-wake work that takes a while, with no await.
            std::thread::sleep(std::time::Duration::from_millis(50));
            d.store(true, Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        clock.set(10.0, 0).await;
        assert!(done.load(Ordering::SeqCst), "set returned before the sleeper finished");
    }

    #[tokio::test]
    async fn due_timers_fire_in_deadline_order_one_at_a_time() {
        let clock = VirtualClock::shared();
        let order = Arc::new(Mutex::new(Vec::new()));
        for (name, ms) in [("c", 30.0), ("a", 10.0), ("b", 20.0)] {
            let (c, o) = (clock.clone(), order.clone());
            tokio::spawn(async move {
                c.sleep(ms).await;
                o.lock().unwrap().push(name);
            });
        }
        tokio::task::yield_now().await;
        assert_eq!(clock.set(100.0, 0).await, 3);
        assert_eq!(*order.lock().unwrap(), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn a_timer_rearmed_by_a_firing_one_fires_in_the_same_set_when_due() {
        let clock = VirtualClock::shared();
        let ticks = Arc::new(Mutex::new(0_u32));
        let (c, t) = (clock.clone(), ticks.clone());
        tokio::spawn(async move {
            for _ in 0..3 {
                c.sleep(10.0).await;
                *t.lock().unwrap() += 1;
            }
        });
        tokio::task::yield_now().await;
        // The wake at 10 re-arms for 20 (virtual now is the set time, so deadline = 10 + 10).
        assert_eq!(clock.set(10.0, 0).await, 1);
        assert_eq!(*ticks.lock().unwrap(), 1);
        assert_eq!(clock.set(30.0, 0).await, 2);
        assert_eq!(*ticks.lock().unwrap(), 3);
    }

    #[tokio::test]
    async fn a_dropped_sleep_leaves_no_timer_and_set_does_not_wait_for_it() {
        let clock = VirtualClock::shared();
        drop(clock.sleep(10.0));
        assert_eq!(clock.pending(), 0);
        let handle = tokio::spawn({
            let c = clock.clone();
            async move { c.sleep(10.0).await }
        });
        tokio::task::yield_now().await;
        handle.abort();
        let _ = handle.await;
        assert_eq!(clock.set(20.0, 0).await, 0);
    }

    #[tokio::test]
    async fn zero_negative_and_nan_delays_are_due_immediately() {
        let clock = VirtualClock::shared();
        for ms in [0.0, -5.0, f64::NAN] {
            let c = clock.clone();
            tokio::spawn(async move { c.sleep(ms).await });
        }
        tokio::task::yield_now().await;
        assert_eq!(clock.set(0.0, 0).await, 3);
    }

    async fn http(addr: std::net::SocketAddr, request: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = String::new();
        stream.read_to_string(&mut out).await.unwrap();
        out
    }

    #[tokio::test]
    async fn the_routes_set_the_clock_and_report_pending_timers() {
        let (clock, router) = install();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await });
        let woke = tokio::spawn(clock.sleep(5.0));
        tokio::task::yield_now().await;
        let get = "GET /__test/time HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n";
        assert!(http(addr, get).await.ends_with(r#"{"pending":1}"#));
        let body = r#"{"mono":10,"wall":1700000000000}"#;
        let post = format!(
            "POST /__test/time HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        let reply = http(addr, &post).await;
        assert!(reply.starts_with("HTTP/1.1 200"), "{reply}");
        assert!(reply.ends_with(r#"{"fired":1}"#), "{reply}");
        woke.await.unwrap();
        assert_eq!(clock.wall_ms(), 1_700_000_000_000);
        let bad = "POST /__test/time HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: 2\r\n\r\n{}";
        assert!(http(addr, bad).await.starts_with("HTTP/1.1 400"));
    }
}
