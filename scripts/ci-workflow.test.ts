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
    expect(wf.jobs["check"]?.["runs-on"]).toBe("ubuntu-latest");
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
    const steps = load().jobs["check"]?.steps ?? [];
    const setup = steps.find((s) => s.uses?.startsWith("oven-sh/setup-bun@"));
    expect(setup?.with?.["bun-version-file"]).toBe(".bun-version");
    const runs = steps.flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]));
    expect(runs[0]).toBe("bun install --frozen-lockfile");
    expect(runs.at(-1)).toBe("bun run check");
  });

  // The Rust half of the gate (ADR 0050) needs cargo-deny; the download is pinned by its checksum.
  test("installs cargo-deny from a pinned release, verified by sha256", () => {
    const runs = (load().jobs["check"]?.steps ?? []).flatMap((s) => (s.run === undefined ? [] : [s.run.trim()]));
    expect(runs.slice(1, -1)).toHaveLength(1);
    const install = runs[1] ?? "";
    const tarball = /releases\/download\/(\d+\.\d+\.\d+)\/(cargo-deny-\1-[\w-]+\.tar\.gz)\n/.exec(install)?.[2];
    expect(tarball).toBeDefined();
    // The checksum covers the very file that is downloaded and unpacked.
    expect(install).toMatch(new RegExp(`echo "[0-9a-f]{64} {2}${(tarball ?? "?").replace(/\./g, "\\.")}" \\| sha256sum -c -`));
    expect(install).toContain(`tar xzf ${tarball ?? "?"} `);
  });
});

// `bun run check` is the gate (ADR 0039 §7); its Rust half (ADR 0050) must keep every check.
describe("package.json check", () => {
  const scripts = (): Record<string, string> =>
    v.parse(v.object({ scripts: v.record(v.string(), v.string()) }), JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))).scripts;

  test("ends by running check:rs", () => {
    expect(scripts()["check"]).toMatch(/ && bun run check:rs$/);
  });

  test("check:rs runs fmt, clippy -D warnings, the tests and cargo-deny, all locked", () => {
    const rs = scripts()["check:rs"] ?? "";
    for (const part of [
      "cargo fmt --all --check",
      "cargo clippy --workspace --all-targets --all-features --locked -- -D warnings",
      "cargo test --workspace --all-features --locked",
      "cargo deny --log-level error check",
    ]) {
      expect(rs).toContain(part);
    }
    expect(rs.split(" && ")).toHaveLength(4);
  });
});
