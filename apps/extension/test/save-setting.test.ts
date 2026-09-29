import { describe, expect, test } from "bun:test";
import { saveServerBaseUrl, type SaveDeps } from "../src/save-setting";

type Calls = { requested: string[]; stored: string[]; removed: string[] };

function deps(overrides: Partial<SaveDeps> = {}): { deps: SaveDeps; calls: Calls } {
  const calls: Calls = { requested: [], stored: [], removed: [] };
  return {
    calls,
    deps: {
      requestOrigin: (pattern) => {
        calls.requested.push(pattern);
        return Promise.resolve(true);
      },
      store: (origin) => {
        calls.stored.push(origin);
        return Promise.resolve();
      },
      removeOrigin: (pattern) => {
        calls.removed.push(pattern);
        return Promise.resolve(true);
      },
      ...overrides,
    },
  };
}

const NGROK = "https://abc123.ngrok-free.app";

describe("saveServerBaseUrl", () => {
  test("saves a new origin after the permission is granted and drops the old one", async () => {
    const { deps: d, calls } = deps();
    const r = await saveServerBaseUrl(NGROK, "https://old.example.com", d);
    expect(r).toEqual({ ok: true, origin: NGROK, message: `Saved. Sharing to ${NGROK}.` });
    expect(calls).toEqual({ requested: [`${NGROK}/*`], stored: [NGROK], removed: ["https://old.example.com/*"] });
  });

  test("the default origin needs no runtime permission", async () => {
    const { deps: d, calls } = deps();
    const r = await saveServerBaseUrl("http://localhost:8787", NGROK, d);
    expect(r.ok).toBe(true);
    expect(calls.requested).toEqual([]);
    expect(calls.removed).toEqual([`${NGROK}/*`]);
  });

  test("never removes the manifest's default permission", async () => {
    const { deps: d, calls } = deps();
    await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    expect(calls.removed).toEqual([]);
  });

  test("invalid input is an error and touches nothing", async () => {
    const { deps: d, calls } = deps();
    const r = await saveServerBaseUrl("http://example.com", "http://localhost:8787", d);
    expect(r.ok).toBe(false);
    expect(calls).toEqual({ requested: [], stored: [], removed: [] });
  });

  test("a denied permission is an error and nothing is stored", async () => {
    const { deps: d, calls } = deps({ requestOrigin: () => Promise.resolve(false) });
    const r = await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    expect(r).toEqual({ ok: false, message: `Permission to reach ${NGROK} was not granted.` });
    expect(calls.stored).toEqual([]);
  });

  test("a rejected permission request is an error, not an unhandled rejection", async () => {
    const { deps: d, calls } = deps({ requestOrigin: () => Promise.reject(new Error("no gesture")) });
    const r = await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Could not save");
    expect(calls.stored).toEqual([]);
  });

  test("a storage failure is an error", async () => {
    const { deps: d } = deps({ store: () => Promise.reject(new Error("quota")) });
    const r = await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Could not save");
  });

  test("the origin is saved even if dropping the old permission fails", async () => {
    const { deps: d, calls } = deps({ removeOrigin: () => Promise.reject(new Error("boom")) });
    const r = await saveServerBaseUrl(NGROK, "https://old.example.com", d);
    expect(r).toEqual({ ok: true, origin: NGROK, message: `Saved. Sharing to ${NGROK}.` });
    expect(calls.stored).toEqual([NGROK]);
  });

  test("the permission is requested synchronously, inside the user gesture", () => {
    const { deps: d, calls } = deps();
    void saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    expect(calls.requested).toEqual([`${NGROK}/*`]);
  });
});
