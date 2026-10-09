import { join } from "node:path";
import { buildStorePackage } from "./package";

// `bun run ext:store` (OME-509): the Web Store upload, built from source into apps/extension/.output.
const pkg = await buildStorePackage({ outDir: join(import.meta.dir, "..", ".output") });
console.log(`${pkg.zipPath}\n  version ${pkg.version} · ${String(pkg.bytes)} bytes · sha256 ${pkg.sha256}`);
