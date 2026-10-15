//! Room shards (OME-1173): a room's sockets run on one home thread, so a publish to its subscribers never wakes
//! another thread. STUB (red commit).

use std::future::Future;
use std::time::Duration;

#[derive(Debug)]
pub struct Shards;

impl Shards {
    /// `n` shard threads, each a current-thread runtime.
    pub fn start(_n: usize) -> std::io::Result<Self> {
        Ok(Self)
    }

    pub fn len(&self) -> usize {
        0
    }

    pub fn is_empty(&self) -> bool {
        true
    }

    /// The shard that owns `room`: stable for the life of the process.
    pub fn index_of(&self, _room: &str) -> usize {
        0
    }

    /// Connection tasks placed on each shard so far.
    pub fn placed(&self) -> Vec<u64> {
        Vec::new()
    }

    /// Runs `fut` on the shard that owns `room`.
    pub fn spawn<F: Future<Output = ()> + Send + 'static>(&self, _room: &str, _fut: F) {}

    /// Stops every shard (their tasks are dropped) and joins the threads, within about `grace`.
    pub fn stop(&self, _grace: Duration) {}
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
