import { describe, expect, test } from "bun:test";
import { testHandleOn } from "../src/test-handle";

// OME-911 (QA OME-1001 round 3): the dev handle `window.__omega` also exists in the perf build, so the harness can
// send an explicit leave before it closes a browser (durable sessions would otherwise hold every closed member).
describe("testHandleOn", () => {
  test("dev builds and builds made with VITE_TEST_HANDLE=1 (perf) expose it", () => {
    expect(testHandleOn({ DEV: true })).toBe(true);
    expect(testHandleOn({ DEV: false, VITE_TEST_HANDLE: "1" })).toBe(true);
  });

  test("a production build without the flag never does", () => {
    expect(testHandleOn({ DEV: false })).toBe(false);
    expect(testHandleOn({ DEV: false, VITE_TEST_HANDLE: "true" })).toBe(false);
    expect(testHandleOn({ DEV: false, VITE_TEST_HANDLE: "" })).toBe(false);
  });
});
