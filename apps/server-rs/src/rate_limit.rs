//! Port of `apps/server/src/rate-limit.ts`: token buckets, the per-key limiter and the client key
//! (ADR 0015 §5). Pure core: every call takes `now` (monotonic ms) instead of reading a clock.
//! `readBodyCapped` is HTTP-layer and lives with slice S5.

use crate::contract::constants::RETRY_AFTER_MAX_MS;

/// `maxKeys` default of the TS `KeyedLimiter`.
pub const DEFAULT_MAX_KEYS: usize = 1024;

#[derive(Debug)]
pub struct TokenBucket {
    burst: f64,
    per_second: f64,
    tokens: f64,
    last: f64,
}

impl TokenBucket {
    pub fn new(burst: f64, per_second: f64, now: f64) -> Self {
        Self {
            burst,
            per_second,
            tokens: 0.0,
            last: now,
        }
    }

    pub fn take(&mut self, _now: f64) -> bool {
        false
    }

    pub fn refund(&mut self, _now: f64) {}

    pub fn retry_after_ms(&mut self, _now: f64) -> f64 {
        -1.0
    }

    pub fn retry_after_ms_capped(&mut self, _now: f64, _max: f64) -> f64 {
        -1.0
    }
}

#[derive(Debug)]
pub struct KeyedLimiter {
    burst: f64,
    per_second: f64,
    max_keys: usize,
}

impl KeyedLimiter {
    pub fn new(burst: f64, per_second: f64, max_keys: usize) -> Self {
        Self {
            burst,
            per_second,
            max_keys,
        }
    }

    pub fn size(&self) -> usize {
        usize::MAX
    }

    pub fn take(&mut self, _key: &str, _now: f64) -> bool {
        false
    }

    pub fn refund(&mut self, _key: &str, _now: f64) {}

    pub fn retry_after_ms(&mut self, _key: &str, _now: f64) -> f64 {
        -1.0
    }

    pub fn retry_after_ms_capped(&mut self, _key: &str, _now: f64, _max: f64) -> f64 {
        -1.0
    }
}

pub fn address_key(_ip: &str) -> String {
    String::new()
}

pub fn is_loopback_key(_key: &str) -> bool {
    false
}

pub fn client_key(_peer: &str, _forwarded_for: Option<&str>, _trust_proxy: bool) -> String {
    String::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    // apps/server/test/rate-limit.test.ts:11
    #[test]
    fn a_burst_passes_the_next_take_is_refused_with_the_time_to_the_next_token_and_refill_restores_it() {
        let mut now = 0.0;
        let mut bucket = TokenBucket::new(5.0, 1.0, now);
        for _ in 0..5 {
            assert!(bucket.take(now));
        }
        assert!(!bucket.take(now));
        assert_eq!(bucket.retry_after_ms(now), 1000.0);
        now += 400.0;
        assert!(!bucket.take(now));
        assert_eq!(bucket.retry_after_ms(now), 600.0);
        now += 600.0;
        assert!(bucket.take(now));
        assert!(!bucket.take(now));
    }

    // apps/server/test/rate-limit.test.ts:27
    #[test]
    fn retry_after_is_0_while_a_token_is_available_and_never_above_the_contract_maximum() {
        let mut bucket = TokenBucket::new(1.0, 0.001, 0.0);
        assert_eq!(bucket.retry_after_ms(0.0), 0.0);
        bucket.take(0.0);
        assert_eq!(bucket.retry_after_ms(0.0), 60_000.0);
        assert_eq!(bucket.retry_after_ms(0.0), RETRY_AFTER_MAX_MS as f64);
        assert_eq!(bucket.retry_after_ms_capped(0.0, 500.0), 500.0);
    }

    // apps/server/src/rate-limit.ts:31 (refund never exceeds burst, and takes effect after a take)
    #[test]
    fn refund_gives_a_token_back_but_never_above_burst() {
        let mut bucket = TokenBucket::new(2.0, 0.001, 0.0);
        assert!(bucket.take(0.0));
        assert!(bucket.take(0.0));
        assert!(!bucket.take(0.0));
        bucket.refund(0.0);
        assert!(bucket.take(0.0));
        assert!(!bucket.take(0.0));
        bucket.refund(0.0);
        bucket.refund(0.0);
        bucket.refund(0.0);
        assert!(bucket.take(0.0));
        assert!(bucket.take(0.0));
        assert!(!bucket.take(0.0));
    }

    // apps/server/src/rate-limit.ts:40: Math.ceil of the fractional wait
    #[test]
    fn retry_after_rounds_the_wait_up() {
        let mut bucket = TokenBucket::new(1.0, 3.0, 0.0);
        assert!(bucket.take(0.0));
        assert_eq!(bucket.retry_after_ms(0.0), 334.0);
    }

    // apps/server/test/rate-limit.test.ts:37
    #[test]
    fn never_holds_more_than_max_keys_buckets_even_when_every_bucket_is_in_use() {
        let mut limiter = KeyedLimiter::new(5.0, 1.0 / 3.0, 100);
        for i in 0..5000 {
            limiter.take(&format!("k{i}"), 0.0);
        }
        assert!(limiter.size() <= 100);
        assert_eq!(limiter.size(), 100);
    }

    // apps/server/test/rate-limit.test.ts:43
    #[test]
    fn evicts_the_least_recently_used_key_keeping_an_active_keys_state() {
        let mut limiter = KeyedLimiter::new(1.0, 0.001, 3);
        assert!(limiter.take("hot", 0.0));
        for i in 0..10 {
            limiter.take(&format!("cold{i}"), 0.0);
            assert!(!limiter.take("hot", 0.0));
        }
    }

    // apps/server/src/rate-limit.ts:68: the oldest key goes, a refused key stays and an evicted key starts fresh
    #[test]
    fn an_evicted_key_starts_with_a_full_bucket_and_refund_of_an_unknown_key_is_a_no_op() {
        let mut limiter = KeyedLimiter::new(1.0, 0.001, 2);
        assert!(limiter.take("a", 0.0));
        assert!(limiter.take("b", 0.0));
        assert!(limiter.take("c", 0.0)); // evicts a
        assert_eq!(limiter.size(), 2);
        assert!(limiter.take("a", 0.0)); // fresh bucket, evicts b
        assert!(!limiter.take("c", 0.0)); // c survived with its state
        limiter.refund("b", 0.0);
        assert_eq!(limiter.size(), 2);
        assert_eq!(limiter.retry_after_ms("b", 0.0), 0.0);
        limiter.refund("c", 0.0);
        assert!(limiter.take("c", 0.0));
    }

    // apps/server/src/rate-limit.ts:64: with max_keys 0 the map still takes the new key
    #[test]
    fn max_keys_zero_still_holds_the_latest_key() {
        let mut limiter = KeyedLimiter::new(1.0, 0.001, 0);
        assert!(limiter.take("a", 0.0));
        assert!(limiter.take("b", 0.0));
        assert_eq!(limiter.size(), 1);
    }

    // apps/server/test/rate-limit.test.ts:54
    #[test]
    fn each_key_has_its_own_bucket_and_its_own_retry_time() {
        let mut limiter = KeyedLimiter::new(6.0, 0.2, DEFAULT_MAX_KEYS);
        for _ in 0..6 {
            assert!(limiter.take("a", 0.0));
        }
        assert!(!limiter.take("a", 0.0));
        assert_eq!(limiter.retry_after_ms("a", 0.0), 5000.0);
        assert!(limiter.take("b", 0.0));
        assert_eq!(limiter.retry_after_ms("unseen", 0.0), 0.0);
        assert!(limiter.take("a", 5000.0));
    }

    // apps/server/test/rate-limit.test.ts:67
    #[test]
    fn is_loopback_key_is_true_only_for_the_keys_of_loopback_peers() {
        for ip in ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"] {
            assert!(is_loopback_key(&address_key(ip)), "{ip}");
        }
        for ip in ["203.0.113.7", "10.0.0.2", "2001:db8::1", "128.0.0.1"] {
            assert!(!is_loopback_key(&address_key(ip)), "{ip}");
        }
        assert!(!is_loopback_key("proxy:unknown"));
        for ip in ["::2", "::ffff:0102:0304", "::"] {
            assert!(!is_loopback_key(&address_key(ip)), "{ip}");
        }
    }

    // apps/server/test/rate-limit.test.ts:77
    #[test]
    fn address_key_keeps_ipv4_folds_mapped_and_keys_ipv6_by_its_slash_64() {
        assert_eq!(address_key("203.0.113.7"), "203.0.113.7");
        assert_eq!(address_key("::ffff:203.0.113.7"), "203.0.113.7");
        assert_eq!(address_key("2001:db8:1:2:aaaa::1"), address_key("2001:db8:1:2:ffff:1:2:3"));
        assert_ne!(address_key("2001:db8:1:2::1"), address_key("2001:db8:1:3::1"));
        assert_eq!(address_key("2001:db8::1"), address_key("2001:0db8:0000:0000:ffff::"));
        assert_eq!(address_key("2001:db8::1"), "2001:db8:0:0::/64");
        assert_eq!(address_key("::1"), "::1");
    }

    // apps/server/test/rate-limit.test.ts:90
    #[test]
    fn without_trust_proxy_x_forwarded_for_is_ignored() {
        assert_eq!(client_key("127.0.0.1", Some("198.51.100.4"), false), "127.0.0.1");
        assert_eq!(client_key("203.0.113.7", Some("198.51.100.4"), false), "203.0.113.7");
    }

    // apps/server/test/rate-limit.test.ts:95
    #[test]
    fn with_trust_proxy_a_non_loopback_peer_still_ignores_x_forwarded_for() {
        for peer in ["203.0.113.7", "10.0.0.2", "::ffff:10.0.0.2", "2001:db8::1", "128.0.0.1"] {
            assert_eq!(client_key(peer, Some("198.51.100.4"), true), address_key(peer));
        }
    }

    // apps/server/test/rate-limit.test.ts:101
    #[test]
    fn behind_the_local_proxy_only_the_rightmost_entry_counts() {
        for peer in ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"] {
            assert_eq!(client_key(peer, Some("198.51.100.4"), true), "198.51.100.4");
            assert_eq!(client_key(peer, Some("6.6.6.6, 7.7.7.7,198.51.100.4"), true), "198.51.100.4");
            assert_eq!(client_key(peer, Some("  198.51.100.4  "), true), "198.51.100.4");
        }
    }

    // apps/server/test/rate-limit.test.ts:109
    #[test]
    fn a_forwarded_ipv6_client_is_keyed_by_its_slash_64() {
        assert_eq!(
            client_key("127.0.0.1", Some("6.6.6.6, 2001:db8:1:2:aaaa::1"), true),
            address_key("2001:db8:1:2::9")
        );
    }

    // apps/server/test/rate-limit.test.ts:113
    #[test]
    fn a_missing_or_unparseable_forwarded_address_falls_into_one_shared_bucket() {
        for xff in [
            None,
            Some(""),
            Some("  "),
            Some("6.6.6.6, not-an-ip"),
            Some("6.6.6.6,"),
            Some("198.51.100.4:4430"),
            Some("999.1.1.1"),
            Some("[::1]"),
        ] {
            assert_eq!(client_key("127.0.0.1", xff, true), "proxy:unknown", "{xff:?}");
        }
    }
}
