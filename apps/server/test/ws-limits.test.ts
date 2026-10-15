import { describe, expect, test } from "bun:test";
import { TokenBucket } from "../src/rate-limit";
import { newMemberBuckets } from "../src/ws-limits";

const drain = (bucket: TokenBucket): number => {
  let taken = 0;
  while (bucket.take()) taken++;
  return taken;
};

describe("newMemberBuckets", () => {
  test("a fresh member gets the threat model's bursts, refilled at their rates (§6)", () => {
    let t = 0;
    const queue = new TokenBucket(1, 1, () => t);
    const buckets = newMemberBuckets(queue, () => t);
    expect(drain(buckets.chat)).toBe(5);
    expect(drain(buckets.sit)).toBe(4);
    expect(drain(buckets.control)).toBe(4);
    expect(buckets.queue).toBe(queue);
    t += 1000;
    expect(drain(buckets.chat)).toBe(1);
    expect(drain(buckets.sit)).toBe(1);
    expect(drain(buckets.control)).toBe(4);
  });
});
