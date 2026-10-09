import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { packageVersion } from "./package";
import { storeZip } from "./zip";

const REPO = join(import.meta.dir, "..", "..", "..");

/**
 * What a rebuild of the extension reads, from the repo root: the root manifest, lockfile and TS base config, every
 * workspace's package.json (so `bun install --frozen-lockfile` sees the lockfile's workspace set), the extension,
 * the wire contract it imports, the store icons, the build notes and the licence.
 */
const FILES = new Set(["SOURCE-BUILD.md", "LICENSE", "package.json", "bun.lock", "tsconfig.base.json", "apps/web/package.json", "apps/server/package.json"]);
const PREFIXES = ["apps/extension/", "packages/shared/", "assets/store/icon-"];

export interface SourcesPackage {
  readonly zipPath: string;
  readonly bytes: number;
  readonly files: number;
}

/** Tracked files only (`git ls-files`), so nothing ignored (node_modules, .output) or untracked ever ships. */
function trackedFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
    .split("\0")
    .filter((path) => FILES.has(path) || PREFIXES.some((prefix) => path.startsWith(prefix)));
}

/**
 * AMO source-code submission (OME-593): `omega-share-<version>-sources.zip`, reproducible like the store zips.
 * Contents come from the working tree, so build it from a clean checkout of the release commit.
 */
export function buildSourcesPackage({ outDir }: { readonly outDir: string }): SourcesPackage {
  const paths = trackedFiles();
  const zip = storeZip(paths.map((path) => ({ path, data: readFileSync(join(REPO, path)) })));
  mkdirSync(outDir, { recursive: true });
  const zipPath = join(outDir, `omega-share-${packageVersion()}-sources.zip`);
  writeFileSync(zipPath, zip);
  return { zipPath, bytes: zip.byteLength, files: paths.length };
}

/** True inside a git checkout; the unpacked sources zip is not one, so a reviewer's rebuild skips this step. */
export function inGitCheckout(): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === REPO;
  } catch {
    return false;
  }
}

/** Paths in the sources zip with uncommitted changes: the zip would not match the commit it claims to be. */
export function dirtySources(): string[] {
  return execFileSync("git", ["status", "--porcelain", "--", ...FILES, ...PREFIXES.map((p) => (p.endsWith("/") ? p : `${p}*`))], { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter((line) => line.trim() !== "");
}
