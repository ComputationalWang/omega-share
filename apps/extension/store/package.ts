import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "wxt";
import { checkStoreManifest, STORE_ZIP_MAX_BYTES } from "./manifest";
import { storeZip } from "./zip";

const ROOT = join(import.meta.dir, "..");

export interface StorePackage {
  readonly zipPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly version: string;
}

function packageVersion(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof pkg !== "object" || pkg === null || !("version" in pkg) || typeof pkg.version !== "string") throw new Error("apps/extension/package.json has no version");
  return pkg.version;
}

/**
 * `bun run ext:store`: a production (`.output/chrome-mv3`-equivalent) build, the packaging guard on its
 * manifest, then a reproducible zip `omega-share-<version>-chrome.zip` ≤ STORE_ZIP_MAX_BYTES next to it.
 * Throws, writing nothing, if the guard or the size check fails.
 */
export async function buildStorePackage({ outDir }: { readonly outDir: string }): Promise<StorePackage> {
  const version = packageVersion();
  await build({ root: ROOT, mode: "production", outDir, outDirTemplate: "chrome-mv3" });
  const dir = join(outDir, "chrome-mv3");

  const problems = checkStoreManifest(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), version);
  if (problems.length > 0) throw new Error(`store manifest check failed:\n- ${problems.join("\n- ")}`);

  const paths = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.endsWith(".map"))
    .map((e) => join(e.parentPath, e.name).slice(dir.length + 1).split("\\").join("/"));
  const zip = storeZip(paths.map((path) => ({ path, data: readFileSync(join(dir, path)) })));
  if (zip.byteLength > STORE_ZIP_MAX_BYTES) throw new Error(`store zip is ${String(zip.byteLength)} bytes, over the ${String(STORE_ZIP_MAX_BYTES)} byte budget`);

  const zipPath = join(outDir, `omega-share-${version}-chrome.zip`);
  writeFileSync(zipPath, zip);
  return { zipPath, bytes: zip.byteLength, sha256: createHash("sha256").update(zip).digest("hex"), version };
}
