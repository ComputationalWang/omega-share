import { join } from "node:path";
import { buildStorePackage } from "./package";
import { buildSourcesPackage, dirtySources, inGitCheckout } from "./sources";

// `bun run ext:store` (OME-509, OME-593): the Chrome Web Store and AMO uploads, built from source into
// apps/extension/.output, plus the repo-root sources zip AMO reviewers rebuild from (SOURCE-BUILD.md).
const outDir = join(import.meta.dir, "..", ".output");
for (const browser of ["chrome", "firefox"] as const) {
  const pkg = await buildStorePackage({ outDir, browser });
  console.log(`${pkg.zipPath}\n  version ${pkg.version} · ${String(pkg.bytes)} bytes · sha256 ${pkg.sha256}`);
}
if (inGitCheckout()) {
  const sources = buildSourcesPackage({ outDir });
  console.log(`${sources.zipPath}\n  ${String(sources.files)} files · ${String(sources.bytes)} bytes`);
  const dirty = dirtySources();
  if (dirty.length > 0) console.warn(`warning: uncommitted changes in the sources zip, don't upload it:\n  ${dirty.join("\n  ")}`);
} else {
  console.log("not a git checkout (an unpacked sources zip): sources zip skipped");
}
