import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStorePackage } from "../store/package";
import { buildSourcesPackage } from "../store/sources";

// AMO source-code submission (OME-593, R-M7c on OME-546): our output is bundled and minified, so the reviewer gets a
// repo-root sources zip and SOURCE-BUILD.md, and must be able to rebuild byte-identical store zips from it.
const REPO = join(import.meta.dir, "..", "..", "..");
const VERSION = (JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as { version: string }).version;
const scratch = mkdtempSync(join(tmpdir(), "omega-ext-sources-"));
afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const entries = (zipPath: string): string[] => execFileSync("unzip", ["-Z1", zipPath], { encoding: "utf8" }).trim().split("\n");

describe("buildSourcesPackage", () => {
  test("zips what the extension build needs from the repo root, byte-identical on a rebuild", () => {
    const first = buildSourcesPackage({ outDir: join(scratch, "a") });
    const second = buildSourcesPackage({ outDir: join(scratch, "b") });
    expect(first.zipPath).toEndWith(`omega-share-${VERSION}-sources.zip`);
    expect(readFileSync(first.zipPath).equals(readFileSync(second.zipPath))).toBe(true);

    const names = entries(first.zipPath);
    for (const needed of [
      "SOURCE-BUILD.md",
      "LICENSE",
      "package.json",
      "bun.lock",
      "tsconfig.base.json",
      "apps/extension/package.json",
      "apps/extension/wxt.config.ts",
      "apps/extension/store/cli.ts",
      "apps/extension/src/entrypoints/popup/main.ts",
      "packages/shared/package.json",
      "packages/shared/src/index.ts",
      "assets/store/icon-128.png",
      // The other workspaces' manifests, so `bun install --frozen-lockfile` sees the lockfile's workspace set.
      "apps/web/package.json",
      "apps/server/package.json",
    ]) {
      expect(names, needed).toContain(needed);
    }
    expect(names.filter((n) => n.startsWith("apps/web/src/") || n.startsWith("apps/server/src/") || n.includes("node_modules/") || n.includes(".output/"))).toEqual([]);
  });

  test("SOURCE-BUILD.md gives the exact Bun version and the commands", () => {
    const doc = readFileSync(join(REPO, "SOURCE-BUILD.md"), "utf8");
    expect(doc).toContain(`Bun ${Bun.version}`);
    expect(doc).toContain("bun install --frozen-lockfile");
    expect(doc).toContain("bun run ext:store");
    expect(doc).toContain(`omega-share-${VERSION}-firefox.zip`);
  });

  test(
    "following SOURCE-BUILD.md in an unpacked copy rebuilds byte-identical Chrome and Firefox zips",
    async () => {
      const here = { chrome: await buildStorePackage({ outDir: join(scratch, "here") }), firefox: await buildStorePackage({ outDir: join(scratch, "here"), browser: "firefox" }) };
      const sources = buildSourcesPackage({ outDir: join(scratch, "zip") });
      const copy = join(scratch, "copy");
      execFileSync("unzip", ["-q", sources.zipPath, "-d", copy]);
      execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: copy, stdio: "pipe" });
      execFileSync("bun", ["run", "ext:store"], { cwd: copy, stdio: "pipe" });
      for (const browser of ["chrome", "firefox"] as const) {
        const rebuilt = readFileSync(join(copy, "apps", "extension", ".output", `omega-share-${VERSION}-${browser}.zip`));
        expect(rebuilt.equals(readFileSync(here[browser].zipPath)), `${browser} zip`).toBe(true);
      }
    },
    600_000,
  );
});
