// Build once per sha (OME-818, ADR 0036 amendment): every build output dir gets a stamp of the tree it was built
// from, so `bun run perf` only rebuilds when a stamp is missing or names another sha or server URL. The stamp lives
// inside the output dir, so any other build of that dir (e.g. `bun run e2e`'s build:e2e) wipes it and forces a rebuild.
// Env files Vite reads (`.env.local`: VITE_SOURCE_URL, the footer link only) are not in the key; after changing one, pass --rebuild.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const STAMP_FILE = ".omega-perf-build";

/** What goes into the builds: a change here, committed or not, means the outputs may be stale. */
export const BUILD_INPUTS = ["apps", "packages", "assets", "package.json", "bun.lock", "tsconfig.base.json"] as const;

export interface GitTree {
  readonly sha: string;
  /** Uncommitted or untracked changes under BUILD_INPUTS. */
  readonly dirty: boolean;
}

export function gitTree(root: string): GitTree {
  const git = (...args: string[]): string => {
    const r = Bun.spawnSync(["git", ...args], { cwd: root, stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
  };
  return { sha: git("rev-parse", "HEAD"), dirty: git("status", "--porcelain", "--", ...BUILD_INPUTS) !== "" };
}

/** The stamp a build of this tree gets. `extra` is anything else baked in (the web build's server URL). Null: never reuse. */
export function buildKey(tree: GitTree, extra: string): string | null {
  return tree.dirty ? null : `${tree.sha} ${extra}`;
}

export function isBuilt(dirs: readonly string[], key: string | null): boolean {
  if (key === null) return false;
  return dirs.every((d) => {
    const stamp = join(d, STAMP_FILE);
    return existsSync(stamp) && readFileSync(stamp, "utf8") === key;
  });
}

export function stampBuild(dirs: readonly string[], key: string | null): void {
  if (key === null) return;
  for (const d of dirs) writeFileSync(join(d, STAMP_FILE), key);
}

export function shouldBuild(flags: ReadonlySet<string>, built: boolean): boolean {
  if (flags.has("--no-build")) return false;
  return flags.has("--rebuild") || !built;
}
