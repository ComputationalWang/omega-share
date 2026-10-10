import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildKey, gitTree, isBuilt, shouldBuild, stampBuild } from "./build-stamp";

// OME-818 (ADR 0036 amendment): `bun run perf` builds once per sha. Each build output dir carries a stamp of the
// tree it was built from; a run rebuilds only when a stamp is missing or names another tree.
const tmp: string[] = [];
const dir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "omega-stamp-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) rmSync(d, { recursive: true, force: true });
});

const CLEAN = { sha: "b818cf6aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", dirty: false };

describe("buildKey", () => {
  test("names the sha and the server URL the web build bakes in", () => {
    const a = buildKey(CLEAN, "http://localhost:8797");
    expect(a).toContain(CLEAN.sha);
    expect(a).not.toBe(buildKey(CLEAN, "http://localhost:8787"));
    expect(a).not.toBe(buildKey({ ...CLEAN, sha: "c81b193aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }, "http://localhost:8797"));
  });

  test("is null for a dirty tree: uncommitted changes always rebuild", () => {
    expect(buildKey({ ...CLEAN, dirty: true }, "")).toBeNull();
  });
});

describe("isBuilt / stampBuild", () => {
  test("a missing output dir or a dir without a stamp is not built", () => {
    const d = dir();
    const key = buildKey(CLEAN, "");
    expect(isBuilt([join(d, "absent")], key)).toBe(false);
    expect(isBuilt([d], key)).toBe(false);
  });

  test("a stamp for the same key is built; another sha or server URL is not", () => {
    const [a, b] = [dir(), dir()];
    const key = buildKey(CLEAN, "http://localhost:8797");
    stampBuild([a, b], key);
    expect(isBuilt([a, b], key)).toBe(true);
    expect(isBuilt([a, b], buildKey({ ...CLEAN, sha: "0".repeat(40) }, "http://localhost:8797"))).toBe(false);
    expect(isBuilt([a, b], buildKey(CLEAN, "http://localhost:8787"))).toBe(false);
  });

  test("every output dir needs the stamp: one dir rebuilt by something else (its stamp wiped) means rebuild", () => {
    const [a, b] = [dir(), dir()];
    const key = buildKey(CLEAN, "");
    stampBuild([a], key);
    expect(isBuilt([a, b], key)).toBe(false);
  });

  test("a dirty tree is never built and never stamped", () => {
    const d = dir();
    stampBuild([d], null);
    expect(isBuilt([d], null)).toBe(false);
    expect(isBuilt([d], buildKey(CLEAN, ""))).toBe(false);
  });
});

describe("shouldBuild", () => {
  test("builds only when the stamp doesn't match; --rebuild forces it, --no-build skips it", () => {
    const none = new Set<string>();
    expect(shouldBuild(none, false)).toBe(true);
    expect(shouldBuild(none, true)).toBe(false);
    expect(shouldBuild(new Set(["--rebuild"]), true)).toBe(true);
    expect(shouldBuild(new Set(["--no-build"]), false)).toBe(false);
  });
});

describe("gitTree", () => {
  const git = (cwd: string, ...args: string[]): string => {
    const r = Bun.spawnSync(["git", "-c", "user.email=qa@omega.test", "-c", "user.name=qa", "-c", "commit.gpgsign=false", ...args], { cwd, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  const repo = (): string => {
    const d = dir();
    git(d, "init", "-q");
    mkdirSync(join(d, "apps/web"), { recursive: true });
    writeFileSync(join(d, "apps/web/main.ts"), "export {};\n");
    writeFileSync(join(d, "notes.md"), "x\n");
    git(d, "add", ".");
    git(d, "commit", "-q", "-m", "init");
    return d;
  };

  test("reads HEAD's sha on a clean tree", () => {
    const d = repo();
    expect(gitTree(d)).toEqual({ sha: git(d, "rev-parse", "HEAD"), dirty: false });
  });

  test("a changed or new file under apps/ makes the tree dirty", () => {
    const d = repo();
    writeFileSync(join(d, "apps/web/main.ts"), "export const x = 1;\n");
    expect(gitTree(d).dirty).toBe(true);
    git(d, "checkout", "--", "apps/web/main.ts");
    writeFileSync(join(d, "apps/web/new.ts"), "export {};\n");
    expect(gitTree(d).dirty).toBe(true);
  });

  test("a change under assets/ makes the tree dirty: the web build bundles the art, the extension copies its icons", () => {
    const d = repo();
    mkdirSync(join(d, "assets/furniture"), { recursive: true });
    writeFileSync(join(d, "assets/furniture/furniture.json"), "{}\n");
    expect(gitTree(d).dirty).toBe(true);
  });

  test("a change outside the build inputs (docs, perf specs) keeps the build", () => {
    const d = repo();
    writeFileSync(join(d, "notes.md"), "y\n");
    expect(gitTree(d).dirty).toBe(false);
  });
});
