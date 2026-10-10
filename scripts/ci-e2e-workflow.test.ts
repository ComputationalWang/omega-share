import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

// CI e2e (OME-822, ADR 0039 §7 amendment): the deterministic Playwright lanes run on every PR, split over 4 shards
// whose blob reports merge into one `e2e` job, the required check. Real-network, perf and Firefox lanes stay local.
const path = new URL("../.github/workflows/e2e.yml", import.meta.url);

const Step = v.object({
  name: v.optional(v.string()),
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  if: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});
const Job = v.object({
  "runs-on": v.string(),
  needs: v.optional(v.union([v.string(), v.array(v.string())])),
  if: v.optional(v.string()),
  strategy: v.optional(
    v.object({
      "fail-fast": v.optional(v.boolean()),
      matrix: v.record(v.string(), v.array(v.unknown())),
    }),
  ),
  steps: v.array(Step),
});
const Workflow = v.object({
  on: v.object({
    pull_request: v.object({ branches: v.array(v.string()) }),
    push: v.object({ branches: v.array(v.string()) }),
  }),
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(v.string(), Job),
});

function load() {
  expect(existsSync(path)).toBe(true);
  return v.parse(Workflow, Bun.YAML.parse(readFileSync(path, "utf8")));
}
const runs = (steps: readonly v.InferOutput<typeof Step>[]): string[] =>
  steps.flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]));

describe(".github/workflows/e2e.yml", () => {
  test("runs on PRs to main and pushes to main with a read-only token", () => {
    const wf = load();
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    expect(wf.on.push.branches).toEqual(["main"]);
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  test("shards the run 4 ways and lets every shard finish", () => {
    const shard = load().jobs["shard"];
    expect(shard?.strategy?.["fail-fast"]).toBe(false);
    expect(shard?.strategy?.matrix["shard"]).toEqual([1, 2, 3, 4]);
  });

  test("each shard runs exactly the deterministic lanes, never e2e-real, perf or Firefox", () => {
    const cmds = runs(load().jobs["shard"]?.steps ?? []);
    const pw = cmds.filter((c) => c.includes("playwright test"));
    expect(pw).toHaveLength(1);
    const cmd = pw[0] ?? "";
    expect(cmd).toContain("--shard=${{ matrix.shard }}/4");
    const projects = [...cmd.matchAll(/--project=(\S+)/g)].map((m) => m[1]);
    expect(projects).toEqual(["e2e", "e2e-sync", "e2e-tunnel"]);
    expect(cmds).toContain("bun run --filter @omega/extension build:e2e");
  });

  test("caches the Playwright browsers keyed on the lockfile", () => {
    const steps = load().jobs["shard"]?.steps ?? [];
    const cache = steps.find((s) => s.uses?.startsWith("actions/cache@"));
    expect(cache?.with?.["path"]).toBe("~/.cache/ms-playwright");
    expect(String(cache?.with?.["key"])).toContain("hashFiles('bun.lock')");
  });

  test("each shard uploads its blob report, and the e2e job merges them and fails when any shard failed", () => {
    const wf = load();
    const upload = (wf.jobs["shard"]?.steps ?? []).find((s) => s.uses?.startsWith("actions/upload-artifact@"));
    expect(upload?.if).toBe("${{ !cancelled() }}");
    expect(upload?.with?.["path"]).toBe("blob-report");
    const merge = wf.jobs["e2e"];
    expect(merge?.needs).toBe("shard");
    expect(merge?.if).toBe("${{ !cancelled() }}");
    const cmds = runs(merge?.steps ?? []);
    expect(cmds.some((c) => c.includes("playwright merge-reports"))).toBe(true);
    expect(cmds.some((c) => c.includes("needs.shard.result") && c.includes("success"))).toBe(true);
  });

  test("pins every action to a full commit SHA with the version in a comment", () => {
    const text = readFileSync(path, "utf8");
    const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(4);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });
});
