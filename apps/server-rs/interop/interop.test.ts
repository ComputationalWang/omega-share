import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asSpecFile, build, dump } from "./dump";
import { dumpPath, rustDbPath, specPath, tsDbPath } from "./paths";
import { spec } from "./spec";

// Rollback safety (ADR 0050): for 7 days after the switch the TS server may be put back on the database
// the Rust server wrote, and the reverse. `dump.json` is what the TS stores read from a database they built;
// the Rust half (tests/store_interop.rs) must read the same from it, and must write a database that reads the same here.
const expected: unknown = JSON.parse(readFileSync(dumpPath, "utf8"));

describe("store interop fixtures (TS side)", () => {
  test("spec.json is what spec.ts says (regenerate: bun apps/server-rs/interop/gen.ts)", () => {
    expect(JSON.parse(readFileSync(specPath, "utf8"))).toEqual(JSON.parse(JSON.stringify(spec)));
  });

  test("replaying the spec through the TS stores reads back as dump.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "omega-interop-build-"));
    try {
      const path = join(dir, "built.db");
      build(asSpecFile(spec), path);
      expect(dump(path)).toEqual(expected as never);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the committed TS-written database reads back as dump.json", () => {
    expect(dump(tsDbPath)).toEqual(expected as never);
  });

  test("the database the Rust stores wrote reads back through the TS stores as dump.json", () => {
    expect(existsSync(rustDbPath)).toBe(true);
    expect(dump(rustDbPath)).toEqual(expected as never);
  });
});
