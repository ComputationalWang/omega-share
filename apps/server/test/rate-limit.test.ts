import { describe, expect, test } from "bun:test";
import { KeyedLimiter, addressKey } from "../src/rate-limit";

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
