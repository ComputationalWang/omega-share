//! Test-only control plane for the black-box suite (ADR 0050, PORTING.md "The black-box suite").
//! Compiled only with the `test-hooks` feature: a virtual clock and the `/__test/time` routes.
//!
//! # Acknowledgement
//! `POST /__test/time` must not answer until the work the new time triggers has finished, or a test
//! would observe the server mid-way. Each armed timer is a pair of one-shot channels: `set` sends the
//! wake on one and waits for the other to close. The sleeper's half of that second channel lives inside
//! its [`Sleep`] future, which the awaiting task drops the moment it resumes, so the close means "woken
//! and running". The task's post-wake work is synchronous by design (PORTING.md "Timers": re-take the
//! lock, re-check, mutate, no `.await` under it), so after the close `set` yields to the scheduler a few
//! times, which lets that work (and any re-arm it does) run to its next `.await` before the next timer
//! or the reply. Timers fire one at a time in deadline order, so the order of effects is deterministic.

use crate::clock::{Clock, SharedClock, Sleep};
use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::StatusCode;
use axum::routing::get;
use serde::Deserialize;
use std::cmp::Ordering;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::sync::oneshot;

/// A sleeper that never answers must not hang the test run.
const ACK_TIMEOUT: Duration = Duration::from_secs(5);
/// A task that re-arms a zero delay forever would make one `set` loop forever.
const MAX_FIRES_PER_SET: usize = 10_000;
/// Upper bound on the scheduler turns `settle` spends per fired timer.
const MAX_SETTLE_YIELDS: usize = 64;

struct Timer {
    id: u64,
    deadline: f64,
    fire: oneshot::Sender<()>,
    /// Resolves (as an error) when the sleeper's future is dropped: the acknowledgement.
    acked: oneshot::Receiver<()>,
}

struct Inner {
    mono: f64,
    wall: i64,
    next_id: u64,
    /// Timers ever armed: with the pending count it shows a woken task still re-arming.
    armed: u64,
    timers: Vec<Timer>,
}

fn lock(inner: &Mutex<Inner>) -> MutexGuard<'_, Inner> {
    inner.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Why a `set` gave up before every due timer had fired and been acknowledged.
#[derive(Debug, PartialEq, Eq)]
pub enum SetError {
    TooManyFires(usize),
    AckTimeout,
}

/// A clock the test moves by hand. `sleep(ms)` resolves when virtual time reaches its deadline.
pub struct VirtualClock {
    inner: Arc<Mutex<Inner>>,
    /// One `set` at a time, so two requests can't interleave their firing.
    setting: tokio::sync::Mutex<()>,
    ack_timeout: Duration,
    max_fires: usize,
}

impl VirtualClock {
    pub fn shared() -> Arc<Self> {
        Self::starting_at(0.0, None)
    }

    /// `wall: None` starts at the real wall time, so a test that never sets it still sees a sane date.
    pub fn starting_at(mono: f64, wall: Option<i64>) -> Arc<Self> {
        Self::with_limits(mono, wall, ACK_TIMEOUT, MAX_FIRES_PER_SET)
    }

    /// Limits for the ack wait and the fires per `set` (tests shrink them).
    pub fn with_limits(mono: f64, wall: Option<i64>, ack_timeout: Duration, max_fires: usize) -> Arc<Self> {
        let wall = wall.unwrap_or_else(|| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
        });
        Arc::new(Self {
            inner: Arc::new(Mutex::new(Inner {
                mono,
                wall,
                next_id: 0,
                armed: 0,
                timers: Vec::new(),
            })),
            setting: tokio::sync::Mutex::new(()),
            ack_timeout,
            max_fires,
        })
    }

    /// Sets both clocks and fires every timer due at or before the new monotonic time, one at a
    /// time in deadline order, waiting for each to be acknowledged. Returns how many fired.
    pub async fn set(&self, mono: f64, wall: i64) -> Result<usize, SetError> {
        let _one_at_a_time = self.setting.lock().await;
        {
            let mut inner = lock(&self.inner);
            inner.mono = mono;
            inner.wall = wall;
        }
        let mut fired = 0;
        while let Some(timer) = self.take_due(mono) {
            if fired == self.max_fires {
                return Err(SetError::TooManyFires(fired));
            }
            fired += 1;
            if timer.fire.send(()).is_ok() {
                // An error here is the acknowledgement; a timeout means the sleeper is stuck.
                if tokio::time::timeout(self.ack_timeout, timer.acked).await.is_err() {
                    return Err(SetError::AckTimeout);
                }
                self.settle().await;
            }
        }
        Ok(fired)
    }

    /// Lets the woken task's post-wake work run. The binary runs on one thread, so that work (and
    /// anything it spawns) runs while this task yields; yield until the timers armed and pending
    /// stop changing across two consecutive yields. Limit: a task that awaits something other than
    /// the scheduler before finishing is not waited for.
    async fn settle(&self) {
        let stamp = || {
            let inner = lock(&self.inner);
            (inner.timers.len(), inner.armed)
        };
        let mut last = stamp();
        let mut steady = 0;
        for _ in 0..MAX_SETTLE_YIELDS {
            tokio::task::yield_now().await;
            let now = stamp();
            if now == last {
                steady += 1;
                if steady == 2 {
                    return;
                }
            } else {
                steady = 0;
                last = now;
            }
        }
    }

    /// The earliest due timer (ties: armed first), removed from the list.
    fn take_due(&self, mono: f64) -> Option<Timer> {
        let mut inner = lock(&self.inner);
        let at = inner
            .timers
            .iter()
            .enumerate()
            .filter(|(_, t)| t.deadline <= mono)
            .min_by(|(_, a), (_, b)| a.deadline.partial_cmp(&b.deadline).unwrap_or(Ordering::Equal).then(a.id.cmp(&b.id)))
            .map(|(i, _)| i)?;
        Some(inner.timers.swap_remove(at))
    }

    /// Timers armed and not yet fired.
    pub fn pending(&self) -> usize {
        lock(&self.inner).timers.len()
    }
}

/// The sleeper's half: resolves on the wake, and its drop is the acknowledgement.
struct VirtualSleep {
    id: u64,
    inner: Arc<Mutex<Inner>>,
    woken: oneshot::Receiver<()>,
    _ack: oneshot::Sender<()>,
}

impl Future for VirtualSleep {
    type Output = ();

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<()> {
        // A closed channel (the clock is gone) also ends the sleep rather than hanging it forever.
        Pin::new(&mut self.woken).poll(cx).map(|_| ())
    }
}

impl Drop for VirtualSleep {
    fn drop(&mut self) {
        let id = self.id;
        lock(&self.inner).timers.retain(|t| t.id != id);
    }
}

impl Clock for VirtualClock {
    fn mono_ms(&self) -> f64 {
        lock(&self.inner).mono
    }

    fn wall_ms(&self) -> i64 {
        lock(&self.inner).wall
    }

    fn sleep(&self, ms: f64) -> Sleep {
        let (fire, woken) = oneshot::channel();
        let (ack, acked) = oneshot::channel();
        let mut inner = lock(&self.inner);
        let id = inner.next_id;
        inner.next_id += 1;
        inner.armed += 1;
        // Negative and NaN delays are due at once.
        let delay = if ms > 0.0 { ms } else { 0.0 };
        let deadline = inner.mono + delay;
        inner.timers.push(Timer { id, deadline, fire, acked });
        drop(inner);
        Box::pin(VirtualSleep {
            id,
            inner: self.inner.clone(),
            woken,
            _ack: ack,
        })
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SetTime {
    mono: f64,
    wall: i64,
}

/// `POST /__test/time {mono, wall}` → `{"fired":n}`, or 500 with a reason when `set` gave up;
/// `GET /__test/time` → `{"pending":n}`. The work runs in its own task, so a client that hangs up
/// can't abandon it half-way (time moved, due timers unfired).
async fn post_time(State(clock): State<Arc<VirtualClock>>, body: Bytes) -> (StatusCode, String) {
    let Ok(t) = serde_json::from_slice::<SetTime>(&body) else {
        return (StatusCode::BAD_REQUEST, r#"{"error":"expected {mono, wall}"}"#.to_owned());
    };
    if !t.mono.is_finite() {
        return (StatusCode::BAD_REQUEST, r#"{"error":"expected {mono, wall}"}"#.to_owned());
    }
    match tokio::spawn(async move { clock.set(t.mono, t.wall).await }).await {
        Ok(Ok(fired)) => (StatusCode::OK, format!(r#"{{"fired":{fired}}}"#)),
        Ok(Err(SetError::TooManyFires(n))) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            format!(r#"{{"error":"fire limit: more than {n} timers due"}}"#),
        ),
        Ok(Err(SetError::AckTimeout)) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            r#"{"error":"ack timeout: a woken sleeper never released its sleep"}"#.to_owned(),
        ),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, r#"{"error":"set task failed"}"#.to_owned()),
    }
}

async fn get_time(State(clock): State<Arc<VirtualClock>>) -> String {
    format!(r#"{{"pending":{}}}"#, clock.pending())
}

/// The starting time from `OMEGA_TEST_MONO` / `OMEGA_TEST_WALL`, so the harness can fix it before the
/// first request without an async handshake. Absent or malformed: mono 0 and the real wall time.
pub fn parse_initial(mono: Option<&str>, wall: Option<&str>) -> (f64, Option<i64>) {
    let mono = mono.and_then(|m| m.parse::<f64>().ok()).filter(|m| m.is_finite());
    (mono.unwrap_or(0.0), wall.and_then(|w| w.parse().ok()))
}

/// The virtual clock and the router that drives it (`POST`/`GET /__test/time`).
pub fn install() -> (SharedClock, Router) {
    let (mono, wall) = parse_initial(
        std::env::var("OMEGA_TEST_MONO").ok().as_deref(),
        std::env::var("OMEGA_TEST_WALL").ok().as_deref(),
    );
    let clock = VirtualClock::starting_at(mono, wall);
    (clock.clone(), routes(clock))
}

/// `POST`/`GET /__test/time` over `clock`.
pub fn routes(clock: Arc<VirtualClock>) -> Router {
    Router::new().route("/__test/time", get(get_time).post(post_time)).with_state(clock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::sync::oneshot;

    #[test]
    fn the_starting_time_comes_from_the_environment_or_defaults() {
        assert_eq!(
            parse_initial(Some("1000000"), Some("1700000000000")),
            (1_000_000.0, Some(1_700_000_000_000))
        );
        assert_eq!(parse_initial(Some("12.5"), None), (12.5, None));
        assert_eq!(parse_initial(None, None), (0.0, None));
        assert_eq!(parse_initial(Some("nope"), Some("1.5")), (0.0, None));
        assert_eq!(parse_initial(Some("NaN"), Some("")), (0.0, None));
    }

    #[tokio::test]
    async fn time_only_moves_when_set() {
        let clock = VirtualClock::shared();
        assert_eq!(clock.set(1_000.0, 5_000).await.unwrap(), 0);
        assert_eq!(clock.mono_ms(), 1_000.0);
        assert_eq!(clock.wall_ms(), 5_000);
    }

    #[tokio::test]
    async fn sleep_resolves_only_when_time_reaches_the_deadline() {
        let clock = VirtualClock::shared();
        clock.set(100.0, 0).await.unwrap();
        let done = Arc::new(AtomicBool::new(false));
        let (c, d) = (clock.clone(), done.clone());
        tokio::spawn(async move {
            c.sleep(50.0).await;
            d.store(true, Ordering::SeqCst);
        });
        tokio::task::yield_now().await;
        assert_eq!(clock.pending(), 1);
        clock.set(149.0, 0).await.unwrap();
        assert!(!done.load(Ordering::SeqCst));
        assert_eq!(clock.set(150.0, 0).await.unwrap(), 1);
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
        clock.set(10.0, 0).await.unwrap();
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
        assert_eq!(clock.set(100.0, 0).await.unwrap(), 3);
        assert_eq!(*order.lock().unwrap(), vec!["a", "b", "c"]);
    }

    #[tokio::test]
    async fn a_timer_rearmed_by_a_firing_one_is_due_relative_to_the_new_time() {
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
        assert_eq!(clock.set(10.0, 0).await.unwrap(), 1);
        assert_eq!(*ticks.lock().unwrap(), 1);
        assert_eq!(clock.set(20.0, 0).await.unwrap(), 1);
        assert_eq!(*ticks.lock().unwrap(), 2);
        assert_eq!(clock.set(30.0, 0).await.unwrap(), 1);
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
        assert_eq!(clock.set(20.0, 0).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn zero_negative_and_nan_delays_are_due_immediately() {
        let clock = VirtualClock::shared();
        for ms in [0.0, -5.0, f64::NAN] {
            let c = clock.clone();
            tokio::spawn(async move { c.sleep(ms).await });
        }
        tokio::task::yield_now().await;
        assert_eq!(clock.set(0.0, 0).await.unwrap(), 3);
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

    #[tokio::test(flavor = "current_thread")]
    async fn set_waits_for_a_task_the_woken_task_spawns() {
        let clock = VirtualClock::shared();
        let done = Arc::new(AtomicBool::new(false));
        let (c, d) = (clock.clone(), done.clone());
        tokio::spawn(async move {
            c.sleep(10.0).await;
            let d = d.clone();
            tokio::spawn(async move {
                std::thread::sleep(std::time::Duration::from_millis(50));
                d.store(true, Ordering::SeqCst);
            });
        });
        tokio::task::yield_now().await;
        clock.set(10.0, 0).await.unwrap();
        assert!(done.load(Ordering::SeqCst), "set returned before the spawned work finished");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_sleeper_that_keeps_rearming_a_zero_delay_hits_the_fire_limit() {
        let clock = VirtualClock::with_limits(0.0, None, Duration::from_secs(5), 20);
        let c = clock.clone();
        tokio::spawn(async move {
            loop {
                c.sleep(0.0).await;
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(clock.set(0.0, 0).await, Err(SetError::TooManyFires(20)));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_sleeper_that_never_lets_go_of_its_future_times_out() {
        let clock = VirtualClock::with_limits(0.0, None, Duration::from_millis(50), 100);
        let c = clock.clone();
        let (held_tx, held_rx) = oneshot::channel::<()>();
        tokio::spawn(async move {
            let sleep = c.sleep(1.0);
            // Keeps the future alive past its wake, so the ack never comes.
            let _ = held_rx.await;
            drop(sleep);
        });
        tokio::task::yield_now().await;
        assert_eq!(clock.set(5.0, 0).await, Err(SetError::AckTimeout));
        drop(held_tx);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn the_route_answers_500_with_a_reason_when_set_gives_up() {
        let clock = VirtualClock::with_limits(0.0, None, Duration::from_millis(50), 100);
        let router = routes(clock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await });
        let (held_tx, held_rx) = oneshot::channel::<()>();
        let c = clock.clone();
        tokio::spawn(async move {
            let sleep = c.sleep(1.0);
            let _ = held_rx.await;
            drop(sleep);
        });
        tokio::task::yield_now().await;
        let body = r#"{"mono":5,"wall":0}"#;
        let post = format!(
            "POST /__test/time HTTP/1.1\r\nhost: x\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        let reply = http(addr, &post).await;
        assert!(reply.starts_with("HTTP/1.1 500"), "{reply}");
        assert!(reply.contains("ack"), "{reply}");
        drop(held_tx);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_client_that_hangs_up_mid_set_does_not_leave_due_timers_unfired() {
        let clock = VirtualClock::shared();
        let router = routes(clock.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, router).await });
        // Two timers are due; the first blocks the (single) thread, so the hang-up lands mid-set.
        let c = clock.clone();
        tokio::spawn(async move {
            c.sleep(5.0).await;
            std::thread::sleep(Duration::from_millis(100));
        });
        let c = clock.clone();
        tokio::spawn(async move { c.sleep(6.0).await });
        tokio::task::yield_now().await;
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let body = r#"{"mono":10,"wall":0}"#;
        let post = format!(
            "POST /__test/time HTTP/1.1\r\nhost: x\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(post.as_bytes()).await.unwrap();
        tokio::time::sleep(Duration::from_millis(20)).await;
        drop(stream);
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(clock.pending(), 0);
        assert_eq!(clock.mono_ms(), 10.0);
    }
}
