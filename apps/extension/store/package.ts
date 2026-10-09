import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "wxt";
import { lintProblems, webExtLint } from "./lint";
import { checkStoreManifest, STORE_ZIP_MAX_BYTES, type StoreBrowser } from "./manifest";
import { storeZip } from "./zip";

const ROOT = join(import.meta.dir, "..");

export interface StorePackage {
  readonly zipPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
}

export function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof pkg !== "object" || pkg === null || !("version" in pkg) || typeof pkg.version !== "string") throw new Error("apps/extension/package.json has no version");
  return pkg.version;
}

/**
 * `bun run ext:store`: a production MV3 build for `browser` (`.output/chrome-mv3` or `.output/firefox-mv3`), the
 * packaging guard on its manifest, for Firefox also `web-ext lint` with 0 errors and no warning but the desktop-only one (OME-593), then a
 * reproducible zip `omega-share-<version>-<browser>.zip` ≤ STORE_ZIP_MAX_BYTES next to it.
 * Throws, writing no zip, if any check fails.
 */
export async function buildStorePackage({ outDir, browser = "chrome" }: { readonly outDir: string; readonly browser?: StoreBrowser }): Promise<StorePackage> {
  const version = packageVersion();
  const target = `${browser}-mv3`;
  await build({ root: ROOT, mode: "production", browser, manifestVersion: 3, outDir, outDirTemplate: target });
  const dir = join(outDir, target);

  const problems = checkStoreManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), version, browser);
  if (problems.length > 0) throw new Error(`store manifest check failed:\n- ${problems.join("\n- ")}`);
  if (browser === "firefox") {
    const findings = lintProblems(await webExtLint(dir));
    if (findings.length > 0) throw new Error(`web-ext lint failed:\n- ${findings.join("\n- ")}`);
  }

  const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith(".map"))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/"));
  const zip = storeZip(paths.map((path) => ({ path, data: readFileSync(join(dir, path)) })));
  if (zip.byteLength > STORE_ZIP_MAX_BYTES) throw new Error(`store zip is ${String(zip.byteLength)} bytes, over the ${String(STORE_ZIP_MAX_BYTES)} byte budget`);

  const zipPath = join(outDir, `omega-share-${version}-${browser}.zip`);
  writeFileSync(zipPath, zip);
  return { zipPath, bytes: zip.byteLength, sha256: createHash("sha256").update(zip).digest("hex"), version };
}
