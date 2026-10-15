//! Room shards (OME-1173, PORTING.md "Performance"): a room's sockets run on one home thread, so a publish to its
//! subscribers never wakes another thread, while different rooms still run on different cores.
//!
//! N shards are N OS threads, each a current-thread runtime. A connection is upgraded on the main runtime (the
//! upgraded IO stays registered with its reactor: a read wakes the shard across threads, which is fine at the
//! client-frame rate), then its task (reader, writer, timers) is spawned on the shard that owns the room.
//! Publishes that start elsewhere (HTTP, GC, admin, drain) reach the outboxes through channels, a cross-thread
//! wake that is rare. A task that panics is caught by tokio and ends only that connection.

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::thread::JoinHandle;
use std::time::Duration;
use tokio::runtime::{Builder, Handle};
use tokio::sync::oneshot;

#[derive(Debug)]
pub struct Shards {
    handles: Vec<Handle>,
    placed: Vec<AtomicU64>,
    stops: Mutex<Vec<oneshot::Sender<Duration>>>,
    threads: Mutex<Vec<JoinHandle<()>>>,
}

/// FNV-1a: stable across runs and builds, unlike a randomly keyed hasher.
fn fnv1a(text: &str) -> u64 {
    text.bytes()
        .fold(0xcbf2_9ce4_8422_2325, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0000_0100_0000_01b3))
}

impl Shards {
    /// `n` shard threads, each a current-thread runtime.
    pub fn start(n: usize) -> std::io::Result<Self> {
        let (mut handles, mut stops, mut threads) = (Vec::new(), Vec::new(), Vec::new());
        for i in 0..n {
            // A few blocking threads per shard: 64 shards must fit systemd TasksMax (ADR 0051 caps the main runtime at 32).
            let runtime = Builder::new_current_thread().enable_all().max_blocking_threads(4).build()?;
            handles.push(runtime.handle().clone());
            let (stop, stopped) = oneshot::channel::<Duration>();
            stops.push(stop);
            threads.push(
                std::thread::Builder::new()
                    .name(format!("omega-shard-{i}"))
                    .spawn(move || {
                        // A dropped sender (the shards were dropped) stops the shard too.
                        let grace = runtime.block_on(stopped).unwrap_or_default();
                        runtime.shutdown_timeout(grace);
                    })?,
            );
        }
        Ok(Self {
            placed: (0..n).map(|_| AtomicU64::new(0)).collect(),
            handles,
            stops: Mutex::new(stops),
            threads: Mutex::new(threads),
        })
    }

    pub fn len(&self) -> usize {
        self.handles.len()
    }

    pub fn is_empty(&self) -> bool {
        self.handles.is_empty()
    }

    /// The shard that owns `room`: stable for the life of the process.
    pub fn index_of(&self, room: &str) -> usize {
        usize::try_from(fnv1a(room) % self.handles.len().max(1) as u64).unwrap_or(0)
    }

    /// Connection tasks placed on each shard so far.
    pub fn placed(&self) -> Vec<u64> {
        self.placed.iter().map(|n| n.load(Ordering::Relaxed)).collect()
    }

    /// Runs `fut` on the shard that owns `room`. After `stop` the task is dropped unrun.
    pub fn spawn<F: Future<Output = ()> + Send + 'static>(&self, room: &str, fut: F) {
        let i = self.index_of(room);
        if let (Some(handle), Some(count)) = (self.handles.get(i), self.placed.get(i)) {
            count.fetch_add(1, Ordering::Relaxed);
            drop(handle.spawn(fut));
        }
    }

    /// Stops every shard (their tasks are dropped) and joins the threads, within about `grace`.
    pub fn stop(&self, grace: Duration) {
        let stops = std::mem::take(&mut *self.stops.lock().unwrap_or_else(PoisonError::into_inner));
        for stop in stops {
            let _ = stop.send(grace);
        }
        let threads = std::mem::take(&mut *self.threads.lock().unwrap_or_else(PoisonError::into_inner));
        for thread in threads {
            let _ = thread.join();
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, reason = "tests")]
mod tests {
    use super::*;
    use std::sync::mpsc::channel;
    use std::time::Instant;

    fn thread_of(shards: &Shards, room: &str) -> std::thread::ThreadId {
        let (tx, rx) = channel();
        shards.spawn(room, async move {
            tx.send(std::thread::current().id()).unwrap();
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap()
    }

    #[test]
    fn placement_is_stable_and_spreads_rooms() {
        let shards = Shards::start(4).unwrap();
        assert_eq!(shards.len(), 4);
        let ids: Vec<String> = (0..64).map(|i| format!("room{i:022}")).collect();
        let first: Vec<usize> = ids.iter().map(|id| shards.index_of(id)).collect();
        assert_eq!(first, ids.iter().map(|id| shards.index_of(id)).collect::<Vec<_>>());
        assert!(first.iter().all(|i| *i < 4));
        for shard in 0..4 {
            assert!(first.contains(&shard), "no room landed on shard {shard}");
        }
        shards.stop(Duration::from_millis(500));
    }

    #[test]
    fn a_room_always_runs_on_its_own_thread_and_rooms_on_different_shards_on_different_threads() {
        let shards = Shards::start(2).unwrap();
        let a = "a".repeat(26);
        let b = (0..)
            .map(|i| format!("b{i:025}"))
            .find(|id| shards.index_of(id) != shards.index_of(&a))
            .unwrap();
        let (ta, tb) = (thread_of(&shards, &a), thread_of(&shards, &b));
        assert_ne!(ta, tb);
        assert_ne!(ta, std::thread::current().id());
        assert_eq!(ta, thread_of(&shards, &a));
        assert_eq!(tb, thread_of(&shards, &b));
        assert_eq!(shards.placed().iter().sum::<u64>(), 4);
        shards.stop(Duration::from_millis(500));
    }

    #[test]
    fn a_panicking_task_does_not_kill_its_shard() {
        let shards = Shards::start(1).unwrap();
        shards.spawn("x", async { panic!("boom (expected by the test)") });
        let _ = thread_of(&shards, "x");
        shards.stop(Duration::from_millis(500));
    }

    #[test]
    fn stop_joins_the_threads_within_the_grace_even_with_a_task_that_never_ends() {
        let shards = Shards::start(2).unwrap();
        shards.spawn("x", std::future::pending());
        let _ = thread_of(&shards, "x");
        let t = Instant::now();
        shards.stop(Duration::from_millis(500));
        assert!(t.elapsed() < Duration::from_secs(1), "{:?}", t.elapsed());
        // The shard is gone: nothing runs any more.
        let (tx, rx) = channel();
        shards.spawn("x", async move {
            let _ = tx.send(());
        });
        assert!(rx.recv_timeout(Duration::from_millis(200)).is_err());
    }
}
