import { expect, test } from "bun:test";
import config from "../playwright.config";

// ADR 0017 §1: Playwright's trace screencast of every context is what dropped vsyncs in M2, so perf runs without it.
test("the perf project runs with Playwright tracing off", () => {
  const perf = config.projects?.find((p) => p.name === "perf");
  expect(perf?.use?.trace).toBe("off");
});
