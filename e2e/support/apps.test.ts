import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { available, extensionBuildError } from "./apps";

// OME-30: the extension has landed, so a missing e2e build must fail the specs, not fixme-skip them green.
test("extension specs are live once apps/extension has a build script", () => {
  expect(available.extension).toBe(true);
});

test("extensionBuildError names the build command when the unpacked build is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "omega-ext-"));
  try {
    expect(extensionBuildError(dir)).toContain("bun run --filter @omega/extension build:e2e");
    writeFileSync(join(dir, "manifest.json"), "{}");
    expect(extensionBuildError(dir)).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
