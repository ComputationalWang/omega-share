// Regenerates the TS half of the rollback-interop fixtures: `bun apps/server-rs/interop/gen.ts`.
// spec.json (the input both stores replay), ts-written.db (built by the TS stores) and dump.json (what the
// TS stores read back). rust-written.db is written by `UPDATE_INTEROP=1 cargo test -p omega-server --test store_interop`.
import { writeFileSync } from "node:fs";
import { build, dump, asSpecFile } from "./dump";
import { spec } from "./spec";
import { specPath, tsDbPath, dumpPath } from "./paths";

writeFileSync(specPath, `${JSON.stringify(spec, null, 2)}\n`);
build(asSpecFile(spec), tsDbPath);
writeFileSync(dumpPath, `${JSON.stringify(dump(tsDbPath), null, 2)}\n`);
console.log("interop fixtures written");
