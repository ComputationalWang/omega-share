import { describe, expect, test } from "bun:test";
import { browserSaveDeps, saveServerBaseUrl, type SaveDeps } from "../src/save-setting";

interface Calls {
  requested: string[];
  stored: string[];
  removed: string[];
}

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

/** A fake `chrome.permissions` + `storage.local` pair: the manifest's default origin is always granted. */
class FakeBrowser {
  readonly granted = new Set<string>(["http://localhost:8787/*"]);
  readonly stored = new Map<string, unknown>();
  answer = true;
  readonly permissions = {
    request: ({ origins = [] }: { origins?: string[] }): Promise<boolean> => {
      if (this.answer) for (const o of origins) this.granted.add(o);
      return Promise.resolve(this.answer);
    },
    remove: ({ origins = [] }: { origins?: string[] }): Promise<boolean> => {
      for (const o of origins) this.granted.delete(o);
      return Promise.resolve(true);
    },
  };
  readonly storage = {
    set: (items: Record<string, unknown>): Promise<void> => {
      for (const [k, v] of Object.entries(items)) this.stored.set(k, v);
      return Promise.resolve();
    },
  };
}

describe("options page flow against a fake chrome.permissions", () => {
  test("switching tunnels keeps exactly one runtime grant: the current origin", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    let current = "http://localhost:8787";
    for (const next of [NGROK, "https://omega.trycloudflare.com", "https://omega.example.com"]) {
      const r = await saveServerBaseUrl(next, current, d);
      expect(r.ok).toBe(true);
      current = next;
      expect([...b.granted].sort()).toEqual(["http://localhost:8787/*", `${next}/*`].sort());
      expect(b.stored.get("serverBaseUrl")).toBe(next);
    }
  });

  test("going back to localhost revokes the tunnel grant and keeps the manifest's", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    await saveServerBaseUrl("http://localhost:8787", NGROK, d);
    expect([...b.granted]).toEqual(["http://localhost:8787/*"]);
    expect(b.stored.get("serverBaseUrl")).toBe("http://localhost:8787");
  });

  test("re-saving the same origin keeps its grant", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    await saveServerBaseUrl(`${NGROK}/`, NGROK, d);
    expect(b.granted.has(`${NGROK}/*`)).toBe(true);
  });

  test("a denied prompt keeps the old origin, its grant and the stored value", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    await saveServerBaseUrl(NGROK, "http://localhost:8787", d);
    b.answer = false;
    const r = await saveServerBaseUrl("https://omega.example.com", NGROK, d);
    expect(r.ok).toBe(false);
    expect([...b.granted].sort()).toEqual(["http://localhost:8787/*", `${NGROK}/*`].sort());
    expect(b.stored.get("serverBaseUrl")).toBe(NGROK);
  });

  test("a hostile URL never reaches chrome.permissions", async () => {
    const b = new FakeBrowser();
    let prompts = 0;
    const d = browserSaveDeps({ ...b.permissions, request: () => ((prompts += 1), Promise.resolve(true)) }, b.storage);
    for (const bad of ["http://evil.com", "https://user:pw@evil.com", "https://10.0.0.1", "https://evil.com/path"]) {
      expect((await saveServerBaseUrl(bad, "http://localhost:8787", d)).ok).toBe(false);
    }
    expect(prompts).toBe(0);
    expect(b.stored.size).toBe(0);
  });
});
