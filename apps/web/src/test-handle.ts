// Whether `window.__omega` (the room's test handle) exists: dev builds, and builds made with VITE_TEST_HANDLE=1 (the
// perf runner's). The harness uses it to send an explicit leave before closing a browser (ADR 0043). Vite inlines both
// values, so a production build without the flag carries no handle.
export function testHandleOn(env: { readonly DEV: boolean; readonly VITE_TEST_HANDLE?: string | undefined }): boolean {
  return env.DEV || env.VITE_TEST_HANDLE === "1";
}
