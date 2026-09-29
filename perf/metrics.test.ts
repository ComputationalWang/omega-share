import { expect, test } from "bun:test";
import { p95 } from "./metrics";

test("p95 picks the nearest-rank sample", () => {
  expect(p95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  expect(p95([5])).toBe(5);
  expect(() => p95([])).toThrow();
});
