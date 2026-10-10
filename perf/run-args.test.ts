import { expect, test } from "bun:test";
import { perfRunArgs } from "./run-args";

// OME-763: targeted post-merge checks (ADR 0036) run one spec through the same build + report: `bun run perf perf/landing.perf.ts`.
test("flags stay flags and every other argument is a spec passed on to Playwright", () => {
  expect(perfRunArgs([])).toEqual({ flags: new Set(), specs: [] });
  const a = perfRunArgs(["--no-build", "perf/landing.perf.ts", "--strict", "perf/site.perf.ts"]);
  expect([...a.flags].sort()).toEqual(["--no-build", "--strict"]);
  expect(a.specs).toEqual(["perf/landing.perf.ts", "perf/site.perf.ts"]);
});

test("unknown flags are refused, so a typo can't run the whole suite unfiltered", () => {
  expect(() => perfRunArgs(["--nobuild"])).toThrow("--nobuild");
  expect(() => perfRunArgs(["--soak", "--only=landing"])).toThrow("--only=landing");
});

test("a spec outside perf/ or not a .perf.ts file is refused", () => {
  expect(() => perfRunArgs(["e2e/home.e2e.ts"])).toThrow("e2e/home.e2e.ts");
  expect(() => perfRunArgs(["landing"])).toThrow("landing");
});
