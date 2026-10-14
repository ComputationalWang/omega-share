// Regenerates the TS half of the rollback-interop fixtures: `bun apps/server-rs/interop/gen.ts`.
// spec.json (the input both stores replay), ts-written.db (built by the TS stores), dump.json (what the TS stores
// read back) and mixed-dump.json (the same after the mixed-history step). rust-written.db and rust-mixed.db are
// written by `UPDATE_INTEROP=1 cargo test -p omega-server --test store_interop`.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSpecFile, build, copyDb, dump, mutate } from "./dump";
import { dumpPath, mixedDumpPath, specPath, tsDbPath } from "./paths";
import { spec } from "./spec";

writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
build(asSpecFile(spec), tsDbPath);
writeFileSync(dumpPath, `${JSON.stringify(dump(tsDbPath), null, 2)}\n`);
const dir = mkdtempSync(join(tmpdir(), "omega-interop-mixed-"));
try {
  const mixed = join(dir, "mixed.db");
  copyDb(tsDbPath, mixed);
  mutate(asSpecFile(spec), mixed);
  writeFileSync(mixedDumpPath, `${JSON.stringify(dump(mixed), null, 2)}\n`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("interop fixtures written");
