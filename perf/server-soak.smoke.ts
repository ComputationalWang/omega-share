// CI-sized soak (`bun run soak:smoke`): ~1.5 minutes against the Bun server (or OMEGA_SOAK_SERVER), with one planned restart.
// Not a `*.test.ts`, so `bun run check` skips it (too slow); the long run is `bun run soak`.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSoak } from "./server-soak";
import { parseSoakArgs } from "./soak-stats";

test("a one-minute soak with one planned restart passes every enforced criterion", async () => {
  const out = mkdtempSync(join(tmpdir(), "soak-smoke-"));
  const args = parseSoakArgs([
    "--server", process.env["OMEGA_SOAK_SERVER"] ?? "bun apps/server/src/index.ts",
    "--minutes", "1",
    "--restart-every-min", "0.5",
    "--sample-s", "1",
    "--window-s", "10",
    "--rooms", "3",
    "--members", "6",
    "--out", out,
  ]);
  const result = await runSoak(args);
  const failed = result.checks.filter((c) => c.enforced && !c.ok);
  expect(failed).toEqual([]);
  expect(result.result.restarts.length).toBeGreaterThanOrEqual(2);
  expect(result.result.restarts.some((r) => r.seatsExpected > 0)).toBe(true);
  expect(existsSync(join(out, "timeline.jsonl"))).toBe(true);
  expect(readFileSync(join(out, "timeline.jsonl"), "utf8").trim().split("\n").length).toBeGreaterThan(30);
  expect(JSON.parse(readFileSync(join(out, "summary.json"), "utf8"))).toMatchObject({ pass: true });
}, 180_000);
