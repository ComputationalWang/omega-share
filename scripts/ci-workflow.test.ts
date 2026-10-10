import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

// The CI gate (ADR 0039 §7, OME-816): the workflow is supply-chain pinned
// and runs exactly the local gate, so a green check means `bun run check`.
const path = new URL("../.github/workflows/check.yml", import.meta.url);

const Step = v.object({
  uses: v.optional(v.string()),
  run: v.optional(v.string()),
  with: v.optional(v.record(v.string(), v.unknown())),
});
const Workflow = v.object({
  on: v.object({
    pull_request: v.object({ branches: v.array(v.string()) }),
    push: v.object({ branches: v.array(v.string()) }),
  }),
  permissions: v.record(v.string(), v.string()),
  jobs: v.record(
    v.string(),
    v.object({ "runs-on": v.string(), steps: v.array(Step) }),
  ),
});

function load() {
  expect(existsSync(path)).toBe(true);
  return v.parse(Workflow, Bun.YAML.parse(readFileSync(path, "utf8")));
}

describe(".github/workflows/check.yml", () => {
  test("runs on PRs to main and pushes to main", () => {
    const wf = load();
    expect(wf.on.pull_request.branches).toEqual(["main"]);
    expect(wf.on.push.branches).toEqual(["main"]);
  });

  test("has one job, named check, on ubuntu-latest, with read-only token", () => {
    const wf = load();
    expect(Object.keys(wf.jobs)).toEqual(["check"]);
    expect(wf.jobs.check?.["runs-on"]).toBe("ubuntu-latest");
    expect(wf.permissions).toEqual({ contents: "read" });
  });

  test("pins every action to a full commit SHA with the version in a comment", () => {
    const text = readFileSync(path, "utf8");
    const uses = [...text.matchAll(/uses:\s*(\S+)(.*)$/gm)];
    expect(uses.length).toBeGreaterThanOrEqual(2);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
      expect(rest).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  test("takes Bun from .bun-version, installs frozen, then runs the gate", () => {
    const steps = load().jobs.check?.steps ?? [];
    const setup = steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
    expect(setup?.with?.["bun-version-file"]).toBe(".bun-version");
    const runs = steps.flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]));
    expect(runs).toEqual(["bun install --frozen-lockfile", "bun run check"]);
  });
});
