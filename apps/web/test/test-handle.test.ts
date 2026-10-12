import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// OME-911/OME-1007: the test handle `window.__omega` exists in dev builds and in builds made with VITE_TEST_HANDLE=1
// (the perf runner's, so its harness can send leave). The gate must be inline `import.meta.env` expressions: Vite
// replaces them with literals and the production build folds the line out entirely (QA OME-1001 round 4).
const main = readFileSync(join(import.meta.dir, "../src/main.ts"), "utf8");

describe("test handle gate in main.ts", () => {
  test("is inline import.meta.env, so a production build drops it", () => {
    expect(main).toContain('if (import.meta.env.DEV || import.meta.env.VITE_TEST_HANDLE === "1") window.__omega = debug;');
  });

  test("goes through no helper Vite can't fold", () => {
    expect(main).not.toContain("testHandleOn");
  });
});
