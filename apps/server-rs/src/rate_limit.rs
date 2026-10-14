//! Port of `apps/server/src/rate-limit.ts`: token buckets, the per-key limiter and the client key
//! (ADR 0015 §5). Pure core: every call takes `now` (monotonic ms) instead of reading a clock.
//! `readBodyCapped` is HTTP-layer and lives with slice S5.

use crate::contract::constants::RETRY_AFTER_MAX_MS;
use crate::contract::js_compat::{is_js_whitespace, js_trim};
use std::collections::{BTreeMap, HashMap};
use std::net::{Ipv4Addr, Ipv6Addr};

/// `maxKeys` default of the TS `KeyedLimiter`.
pub const DEFAULT_MAX_KEYS: usize = 1024;

/// Classic token bucket: `burst` tokens, refilled at `per_second`. Allocation-free per call.
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
            tokens: burst,
            last: now,
        }
    }

    /// Takes a token if one is available.
    pub fn take(&mut self, now: f64) -> bool {
        self.refill(now);
        if self.tokens < 1.0 {
            return false;
        }
        self.tokens -= 1.0;
        true
    }

    /// Gives back a token taken for work that then failed on the server's side (never above `burst`).
    pub fn refund(&mut self, now: f64) {
        self.refill(now);
        self.tokens = self.burst.min(self.tokens + 1.0);
    }

    /// Milliseconds until a token is available (0 if one is), capped at the contract's `RETRY_AFTER_MAX_MS`.
    pub fn retry_after_ms(&mut self, now: f64) -> f64 {
        self.retry_after_ms_capped(now, RETRY_AFTER_MAX_MS as f64)
    }

    /// Like [`Self::retry_after_ms`] with another cap.
    pub fn retry_after_ms_capped(&mut self, now: f64, max: f64) -> f64 {
        self.refill(now);
        if self.tokens >= 1.0 {
            return 0.0;
        }
        max.min((((1.0 - self.tokens) / self.per_second) * 1000.0).ceil())
    }

    fn refill(&mut self, now: f64) {
        self.tokens = self.burst.min(self.tokens + ((now - self.last) / 1000.0) * self.per_second);
        self.last = now;
    }
}

/// One bucket per key (e.g. client address), at most `max_keys` of them. The least recently used key is
/// evicted first (the TS `Map` keeps insertion order and re-inserts on use), so the map can't grow without bound.
#[derive(Debug)]
pub struct KeyedLimiter {
    burst: f64,
    per_second: f64,
    max_keys: usize,
    /// key -> (bucket, recency stamp)
    buckets: HashMap<String, (TokenBucket, u64)>,
    /// recency stamp -> key; the first entry is the least recently used.
    order: BTreeMap<u64, String>,
    stamp: u64,
}

impl KeyedLimiter {
    pub fn new(burst: f64, per_second: f64, max_keys: usize) -> Self {
        Self {
            burst,
            per_second,
            max_keys,
            buckets: HashMap::new(),
            order: BTreeMap::new(),
            stamp: 0,
        }
    }

    pub fn size(&self) -> usize {
        self.buckets.len()
    }

    /// Takes a token for `key`; the key becomes the most recently used one.
    pub fn take(&mut self, key: &str, now: f64) -> bool {
        self.stamp += 1;
        let stamp = self.stamp;
        if let Some((bucket, old)) = self.buckets.get_mut(key) {
            let owned = self.order.remove(old).unwrap_or_else(|| key.to_owned());
            *old = stamp;
            self.order.insert(stamp, owned);
            return bucket.take(now);
        }
        if self.buckets.len() >= self.max_keys
            && let Some((_, oldest)) = self.order.pop_first()
        {
            self.buckets.remove(&oldest);
        }
        let mut bucket = TokenBucket::new(self.burst, self.per_second, now);
        let taken = bucket.take(now);
        self.buckets.insert(key.to_owned(), (bucket, stamp));
        self.order.insert(stamp, key.to_owned());
        taken
    }

    /// Gives `key` back a token it took (no-op for a key that has since been evicted).
    pub fn refund(&mut self, key: &str, now: f64) {
        if let Some((bucket, _)) = self.buckets.get_mut(key) {
            bucket.refund(now);
        }
    }

    /// Milliseconds until `key` may take again; 0 for a key with a token or no bucket.
    pub fn retry_after_ms(&mut self, key: &str, now: f64) -> f64 {
        self.retry_after_ms_capped(key, now, RETRY_AFTER_MAX_MS as f64)
    }

    pub fn retry_after_ms_capped(&mut self, key: &str, now: f64, max: f64) -> f64 {
        self.buckets
            .get_mut(key)
            .map_or(0.0, |(bucket, _)| bucket.retry_after_ms_capped(now, max))
    }
}

fn digits(s: &str) -> bool {
    !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())
}

/// `/^(?:::ffff:)?127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/i`
fn is_loopback_v4(s: &str) -> bool {
    let rest = match s.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("::ffff:") => s.get(7..).unwrap_or(""),
        _ => s,
    };
    let parts: Vec<&str> = rest.split('.').collect();
    matches!(parts.as_slice(), ["127", a, b, c] if [a, b, c].iter().all(|p| p.len() <= 3 && digits(p)))
}

/// Whether a client key (from [`client_key`]) is a loopback peer: local dev, tests and the load probe. The
/// per-key WS limits skip these. Behind the tunnel the key is the forwarded client address, never loopback.
pub fn is_loopback_key(key: &str) -> bool {
    key == "::1" || is_loopback_v4(key)
}

/// `/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i`: the IPv4 part.
fn mapped_v4(ip: &str) -> Option<&str> {
    let prefix = ip.get(..7)?;
    if !prefix.eq_ignore_ascii_case("::ffff:") {
        return None;
    }
    let rest = ip.get(7..)?;
    let parts: Vec<&str> = rest.split('.').collect();
    (parts.len() == 4 && parts.iter().all(|p| digits(p))).then_some(rest)
}

/// `parseInt(g, 16).toString(16)`: leading JS whitespace, a sign, an optional `0x`, then the hex digits.
fn parse_int16_to_hex(g: &str) -> String {
    let t = g.trim_start_matches(is_js_whitespace);
    let (negative, t) = match t.strip_prefix('-') {
        Some(rest) => (true, rest),
        None => (false, t.strip_prefix('+').unwrap_or(t)),
    };
    let t = match t.get(..2) {
        Some(p) if p.eq_ignore_ascii_case("0x") => t.get(2..).unwrap_or(""),
        _ => t,
    };
    let end = t.find(|c: char| !c.is_ascii_hexdigit()).unwrap_or(t.len());
    let Some(run) = t.get(..end).filter(|r| !r.is_empty()) else {
        return "NaN".to_owned();
    };
    // Up to 32 digits fit u128 exactly; the double is the correctly rounded value, as in JS.
    let value = match u128::from_str_radix(run, 16) {
        Ok(n) => n as f64,
        // shortcut: more than 32 hex digits accumulate in f64 (error beyond 2^53 may differ from V8); real addresses never have them.
        Err(_) => run
            .chars()
            .filter_map(|c| c.to_digit(16))
            .fold(0.0, |acc, d| acc * 16.0 + f64::from(d)),
    };
    if value == 0.0 {
        return "0".to_owned();
    }
    let hex = if value.is_infinite() {
        "Infinity".to_owned()
    } else {
        f64_hex(value)
    };
    if negative { format!("-{hex}") } else { hex }
}

/// Exact hex of a positive finite integral double (what `Number#toString(16)` prints).
fn f64_hex(v: f64) -> String {
    let bits = v.to_bits();
    let exp = ((bits >> 52) & 0x7ff) as i64;
    let mant = (bits & ((1 << 52) - 1)) | (1 << 52);
    let shift = exp - 1075;
    if shift <= 0 {
        return format!("{:x}", (mant >> (-shift).min(63)));
    }
    format!("{:x}{}", mant << (shift % 4), "0".repeat((shift / 4) as usize))
}

/// Rate-limit key for a peer address. IPv4 (including IPv4-mapped IPv6) is kept as is; IPv6 is keyed by
/// its /64, because one host usually controls a whole /64.
pub fn address_key(ip: &str) -> String {
    if let Some(v4) = mapped_v4(ip) {
        return v4.to_owned();
    }
    if !ip.contains(':') {
        return ip.to_owned();
    }
    // Its own key, so `is_loopback_key` can't match other addresses of ::/64 (::2, hex-form IPv4-mapped).
    if ip == "::1" {
        return ip.to_owned();
    }
    // JS `split("::", 2)`: the first two pieces only.
    let mut pieces = ip.split("::");
    let head = pieces.next().unwrap_or("");
    let tail = pieces.next().unwrap_or("");
    let h: Vec<&str> = if head.is_empty() { Vec::new() } else { head.split(':').collect() };
    let t: Vec<&str> = if ip.contains("::") && !tail.is_empty() {
        tail.split(':').collect()
    } else {
        Vec::new()
    };
    let zeros = 8usize.saturating_sub(h.len() + t.len());
    let groups = h.iter().copied().chain(std::iter::repeat_n("0", zeros)).chain(t.iter().copied());
    let mut key = groups.take(4).map(parse_int16_to_hex).collect::<Vec<_>>().join(":");
    key.push_str("::/64");
    key
}

/// Node's `net.isIP(s) !== 0`: dotted-quad IPv4 without leading zeros, or IPv6 with an optional `%zone`.
fn is_ip(s: &str) -> bool {
    if s.parse::<Ipv4Addr>().is_ok() {
        return true;
    }
    let addr = match s.split_once('%') {
        Some((addr, zone)) if !zone.is_empty() && zone.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b':')) => {
            addr
        }
        Some(_) => return false,
        None => s,
    };
    addr.parse::<Ipv6Addr>().is_ok()
}

/// Rate-limit key for a request (ADR 0015 §5). `X-Forwarded-For` counts only with `trust_proxy` and a
/// loopback peer (the tunnel agent), and then only its rightmost entry: the tunnel appends it, so a client
/// can't choose it. Anything else there shares one `proxy:unknown` bucket.
pub fn client_key(peer: &str, forwarded_for: Option<&str>, trust_proxy: bool) -> String {
    if !trust_proxy || !(peer == "::1" || is_loopback_v4(peer)) {
        return address_key(peer);
    }
    // Repeated headers are joined with ", " by the caller, so this is also the last header's last entry.
    let last = forwarded_for.map_or("", |f| js_trim(f.rsplit(',').next().unwrap_or("")));
    if is_ip(last) {
        address_key(last)
    } else {
        "proxy:unknown".to_owned()
    }
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
