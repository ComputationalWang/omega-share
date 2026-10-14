import { join } from "node:path";

export const specPath = join(import.meta.dir, "spec.json");
export const tsDbPath = join(import.meta.dir, "ts-written.db");
export const rustDbPath = join(import.meta.dir, "rust-written.db");
/** The Rust stores applied the mixed step to a copy of the TS-written database. */
export const rustMixedDbPath = join(import.meta.dir, "rust-mixed.db");
export const dumpPath = join(import.meta.dir, "dump.json");
export const mixedDumpPath = join(import.meta.dir, "mixed-dump.json");
