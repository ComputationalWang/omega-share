import { join } from "node:path";

export const specPath = join(import.meta.dir, "spec.json");
export const tsDbPath = join(import.meta.dir, "ts-written.db");
export const rustDbPath = join(import.meta.dir, "rust-written.db");
export const dumpPath = join(import.meta.dir, "dump.json");
