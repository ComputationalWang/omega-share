import { expect, test } from "bun:test";
import config from "../playwright.config";

// ADR 0017 §1: Playwright's trace screencast of every context is what dropped vsyncs in M2, so perf runs without it.
test("the perf project runs with Playwright tracing off", () => {
  const perf = config.projects?.find((p) => p.name === "perf");
  expect(perf?.use?.trace).toBe("off");
});

// OME-750: a typo in OMEGA_PERF_MOTION would run the suite unforced while the run reads as forced.
const loadConfig = (motion: string) =>
  Bun.spawnSync(["bun", "-e", "await import('./playwright.config.ts')"], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, OMEGA_PERF_MOTION: motion }, stderr: "pipe" });

test("OMEGA_PERF_MOTION accepts smooth, basic or empty, and refuses anything else", () => {
  for (const ok of ["smooth", "basic", ""]) expect(loadConfig(ok).exitCode).toBe(0);
  for (const bad of ["Smooth", "smoth", "BASIC"]) {
    const run = loadConfig(bad);
    expect(run.exitCode).not.toBe(0);
    expect(run.stderr.toString()).toContain("OMEGA_PERF_MOTION");
  }
});
