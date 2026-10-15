import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

// CI e2e against the Rust server (OME-1170, ADR 0050): the same three deterministic lanes with E2E_SERVER=rust, only on
// PRs that touch apps/server-rs. Not a required check (a path-filtered workflow does not run on other PRs).
const path = new URL("../.github/workflows/e2e-rust.yml", import.meta.url);

const Step = v.object({
  name: v.optional(v.string()),
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  env: v.optional(v.record(v.string(), v.string())),
  with: v.optional(v.record(v.string(), v.unknown())),
});
const Workflow = v.object({
  on: v.object({
    pull_request: v.object({ branches: v.array(v.string()), paths: v.array(v.string()) }),
  }),
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(
    v.string(),
    v.object({
      "runs-on": v.string(),
      strategy: v.optional(v.object({ "fail-fast": v.optional(v.boolean()), matrix: v.record(v.string(), v.array(v.unknown())) })),
      steps: v.array(Step),
    }),
  ),
});

function load() {
  expect(existsSync(path)).toBe(true);
  return v.parse(Workflow, Bun.YAML.parse(readFileSync(path, "utf8")));
}

describe(".github/workflows/e2e-rust.yml", () => {
  test("runs on PRs to main that touch the Rust server, with a read-only token", () => {
    const wf = load();
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    expect(wf.on.pull_request.paths).toContain("apps/server-rs/**");
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  test("pins every action to a full commit SHA", () => {
    const uses = [...readFileSync(path, "utf8").matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(3);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  test("shards the deterministic lanes 4 ways with E2E_SERVER=rust, never e2e-real or perf", () => {
    const job = load().jobs["shard"];
    expect(job?.strategy?.matrix["shard"]).toEqual([1, 2, 3, 4]);
    const step = (job?.steps ?? []).find((s) => s.run?.includes("playwright test"));
    expect(step?.env?.["E2E_SERVER"]).toBe("rust");
    const cmd = step?.run ?? "";
    expect(cmd).toContain("--shard=${{ matrix.shard }}/4");
    expect([...cmd.matchAll(/--project=(\S+)/g)].map((m) => m[1])).toEqual(["e2e", "e2e-sync", "e2e-tunnel"]);
  });

  test("reuses the Rust build cache of check.yml", () => {
    const cache = (load().jobs["shard"]?.steps ?? []).find((s) => s.name === "Cache Rust build");
    expect(cache?.with?.["key"]).toBe("cargo-${{ runner.os }}-${{ hashFiles('rust-toolchain.toml', 'Cargo.lock') }}");
  });
});
