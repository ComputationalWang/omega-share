import { describe, expect, test } from "bun:test";
import { KeyedLimiter, TokenBucket, addressKey, clientKey, isLoopbackKey } from "../src/rate-limit";

/** A clock the test moves by hand, in ms. */
function fakeClock() {
  const clock = { ms: 0, now: () => clock.ms };
  return clock;
}

describe("TokenBucket with an injected clock", () => {
  test("a burst passes, the next take is refused with the time to the next token, and refill restores it", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(5, 1, clock.now);
    for (let i = 0; i < 5; i++) expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
    expect(bucket.retryAfterMs()).toBe(1000);
    clock.ms += 400;
    expect(bucket.take()).toBe(false);
    expect(bucket.retryAfterMs()).toBe(600);
    clock.ms += 600;
    expect(bucket.take()).toBe(true);
    expect(bucket.take()).toBe(false);
  });

  test("retryAfterMs is 0 while a token is available and never above the contract maximum", () => {
    const clock = fakeClock();
    const bucket = new TokenBucket(1, 0.001, clock.now);
    expect(bucket.retryAfterMs()).toBe(0);
    bucket.take();
    expect(bucket.retryAfterMs()).toBe(60_000);
  });
});


describe("KeyedLimiter", () => {
  test("never holds more than maxKeys buckets, even when every bucket is in use", () => {
    const limiter = new KeyedLimiter(5, 1 / 3, 100);
    for (let i = 0; i < 5000; i++) limiter.take(`k${String(i)}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });

  test("evicts the least recently used key, keeping an active key's state", () => {
    const limiter = new KeyedLimiter(1, 0.001, 3);
    expect(limiter.take("hot")).toBe(true);
    for (let i = 0; i < 10; i++) {
      limiter.take(`cold${String(i)}`);
      expect(limiter.take("hot")).toBe(false);
    }
  });
});

describe("KeyedLimiter with an injected clock", () => {
  test("each key has its own bucket and its own retry time", () => {
    const clock = fakeClock();
    const limiter = new KeyedLimiter(6, 0.2, 1024, clock.now);
    for (let i = 0; i < 6; i++) expect(limiter.take("a")).toBe(true);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.retryAfterMs("a")).toBe(5000);
    expect(limiter.take("b")).toBe(true);
    expect(limiter.retryAfterMs("unseen")).toBe(0);
    clock.ms += 5000;
    expect(limiter.take("a")).toBe(true);
  });
});

describe("isLoopbackKey", () => {
  test("is true only for the keys of loopback peers", () => {
    for (const ip of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackKey(addressKey(ip))).toBe(true);
    for (const ip of ["203.0.113.7", "10.0.0.2", "2001:db8::1", "128.0.0.1"]) expect(isLoopbackKey(addressKey(ip))).toBe(false);
    expect(isLoopbackKey("proxy:unknown")).toBe(false);
    // Same /64 key as ::1 before, but not loopback: ::2, hex-form IPv4-mapped, the unspecified address.
    for (const ip of ["::2", "::ffff:0102:0304", "::"]) expect(isLoopbackKey(addressKey(ip))).toBe(false);
  });
});

describe("addressKey", () => {
  test("keeps IPv4 addresses as they are", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
  });
  test("folds IPv4-mapped IPv6 into IPv4", () => {
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });
  test("keys IPv6 by its /64 so one host can't rotate through its prefix", () => {
    expect(addressKey("2001:db8:1:2:aaaa::1")).toBe(addressKey("2001:db8:1:2:ffff:1:2:3"));
    expect(addressKey("2001:db8:1:2::1")).not.toBe(addressKey("2001:db8:1:3::1"));
    expect(addressKey("2001:db8::1")).toBe(addressKey("2001:0db8:0000:0000:ffff::"));
  });
});

describe("clientKey (ADR 0015 §5)", () => {
  test("without TRUST_PROXY, X-Forwarded-For is ignored and the peer is the key (T-08)", () => {
    expect(clientKey("127.0.0.1", "198.51.100.4", false)).toBe("127.0.0.1");
    expect(clientKey("203.0.113.7", "198.51.100.4", false)).toBe("203.0.113.7");
  });

  test("with TRUST_PROXY, X-Forwarded-For from a non-loopback peer is still ignored (T-08)", () => {
    for (const peer of ["203.0.113.7", "10.0.0.2", "::ffff:10.0.0.2", "2001:db8::1", "128.0.0.1"]) {
      expect(clientKey(peer, "198.51.100.4", true)).toBe(addressKey(peer));
    }
  });

  test("behind the local proxy, only the rightmost entry counts: the one the tunnel appended (T-07)", () => {
    for (const peer of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      expect(clientKey(peer, "198.51.100.4", true)).toBe("198.51.100.4");
      expect(clientKey(peer, "6.6.6.6, 7.7.7.7,198.51.100.4", true)).toBe("198.51.100.4");
      expect(clientKey(peer, "  198.51.100.4  ", true)).toBe("198.51.100.4");
    }
  });

  test("a forwarded IPv6 client is keyed by its /64", () => {
    expect(clientKey("127.0.0.1", "6.6.6.6, 2001:db8:1:2:aaaa::1", true)).toBe(addressKey("2001:db8:1:2::9"));
  });

  test("a missing or unparseable forwarded address falls into one shared bucket", () => {
    for (const xff of [null, "", "  ", "6.6.6.6, not-an-ip", "6.6.6.6,", "198.51.100.4:4430", "999.1.1.1", "[::1]"]) {
      expect(clientKey("127.0.0.1", xff, true)).toBe("proxy:unknown");
    }
  });
});
