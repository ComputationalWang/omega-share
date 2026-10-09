import { describe, expect, test } from "bun:test";
import { browserSaveDeps, saveServerBaseUrl, type SaveDeps } from "../src/save-setting";

interface Calls {
  requested: string[];
  stored: string[];
  removed: string[];
}

/** `stored`: what `storage.local` holds when the save starts (the origin whose grant gets revoked). */
function deps(overrides: Partial<SaveDeps> = {}, stored = "http://localhost:8787"): { deps: SaveDeps; calls: Calls } {
  const calls: Calls = { requested: [], stored: [], removed: [] };
  return {
    calls,
    deps: {
      readStored: () => Promise.resolve(stored),
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
    const { deps: d, calls } = deps({}, "https://old.example.com");
    const r = await saveServerBaseUrl(NGROK, d);
    expect(r).toEqual({ ok: true, origin: NGROK, message: `Saved. Sharing to ${NGROK}.` });
    expect(calls).toEqual({ requested: [`${NGROK}/*`], stored: [NGROK], removed: ["https://old.example.com/*"] });
  });

  test("the default origin needs no runtime permission", async () => {
    const { deps: d, calls } = deps({}, NGROK);
    const r = await saveServerBaseUrl("http://localhost:8787", d);
    expect(r.ok).toBe(true);
    expect(calls.requested).toEqual([]);
    expect(calls.removed).toEqual([`${NGROK}/*`]);
  });

  test("never removes the manifest's default permission", async () => {
    const { deps: d, calls } = deps();
    await saveServerBaseUrl(NGROK, d);
    expect(calls.removed).toEqual([]);
  });

  test("invalid input is an error and touches nothing", async () => {
    const { deps: d, calls } = deps();
    const r = await saveServerBaseUrl("http://example.com", d);
    expect(r.ok).toBe(false);
    expect(calls).toEqual({ requested: [], stored: [], removed: [] });
  });

  test("a denied permission is an error and nothing is stored", async () => {
    const { deps: d, calls } = deps({ requestOrigin: () => Promise.resolve(false) });
    const r = await saveServerBaseUrl(NGROK, d);
    expect(r).toEqual({ ok: false, message: `Permission to reach ${NGROK} was not granted.` });
    expect(calls.stored).toEqual([]);
  });

  test("a rejected permission request is an error, not an unhandled rejection", async () => {
    const { deps: d, calls } = deps({ requestOrigin: () => Promise.reject(new Error("no gesture")) });
    const r = await saveServerBaseUrl(NGROK, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Could not save");
    expect(calls.stored).toEqual([]);
  });

  test("a storage failure is an error", async () => {
    const { deps: d } = deps({ store: () => Promise.reject(new Error("quota")) });
    const r = await saveServerBaseUrl(NGROK, d);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain("Could not save");
  });

  test("the origin is saved even if dropping the old permission fails", async () => {
    const { deps: d, calls } = deps({ removeOrigin: () => Promise.reject(new Error("boom")) }, "https://old.example.com");
    const r = await saveServerBaseUrl(NGROK, d);
    expect(r).toEqual({ ok: true, origin: NGROK, message: `Saved. Sharing to ${NGROK}.` });
    expect(calls.stored).toEqual([NGROK]);
  });

  test("an unreadable stored origin still saves, and revokes nothing", async () => {
    const { deps: d, calls } = deps({ readStored: () => Promise.reject(new Error("storage gone")) });
    const r = await saveServerBaseUrl(NGROK, d);
    expect(r.ok).toBe(true);
    expect(calls.stored).toEqual([NGROK]);
    expect(calls.removed).toEqual([]);
  });

  test("a server with a port asks for its host on any port, which Firefox can match (QA OME-687)", async () => {
    const { deps: d, calls } = deps({}, "https://old.example.com");
    await saveServerBaseUrl("https://qa682.test:8968", d);
    expect(calls.requested).toEqual(["https://qa682.test/*"]);
    expect(calls.removed).toEqual(["https://old.example.com/*"]);
  });

  test("moving to another port on the same host keeps the shared grant", async () => {
    const { deps: d, calls } = deps({}, "https://qa682.test:8968");
    const r = await saveServerBaseUrl("https://qa682.test:9443", d);
    expect(r.ok).toBe(true);
    expect(calls.removed).toEqual([]);
  });

  test("leaving a local server on another port never revokes the default's localhost grant", async () => {
    const { deps: d, calls } = deps({}, "http://localhost:8858");
    await saveServerBaseUrl(NGROK, d);
    expect(calls.removed).toEqual([]);
  });

  test("the permission is requested synchronously, inside the user gesture", () => {
    const { deps: d, calls } = deps();
    void saveServerBaseUrl(NGROK, d);
    expect(calls.requested).toEqual([`${NGROK}/*`]);
  });
});

/** A fake `chrome.permissions` + `storage.local` pair: the manifest's default origin is always granted. */
class FakeBrowser {
  readonly granted = new Set<string>(["http://localhost/*"]);
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
    get: (key: string): Promise<Record<string, unknown>> => Promise.resolve(this.stored.has(key) ? { [key]: this.stored.get(key) } : {}),
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
    for (const next of [NGROK, "https://omega.trycloudflare.com", "https://omega.example.com"]) {
      const r = await saveServerBaseUrl(next, d);
      expect(r.ok).toBe(true);
      expect([...b.granted].sort()).toEqual(["http://localhost/*", `${next}/*`].sort());
      expect(b.stored.get("serverBaseUrl")).toBe(next);
    }
  });

  test("going back to localhost revokes the tunnel grant and keeps the manifest's", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    await saveServerBaseUrl(NGROK, d);
    await saveServerBaseUrl("http://localhost:8787", d);
    expect([...b.granted]).toEqual(["http://localhost/*"]);
    expect(b.stored.get("serverBaseUrl")).toBe("http://localhost:8787");
  });

  test("re-saving the same origin keeps its grant", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    await saveServerBaseUrl(NGROK, d);
    await saveServerBaseUrl(`${NGROK}/`, d);
    expect(b.granted.has(`${NGROK}/*`)).toBe(true);
  });

  test("a denied prompt keeps the old origin, its grant and the stored value", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    await saveServerBaseUrl(NGROK, d);
    b.answer = false;
    const r = await saveServerBaseUrl("https://omega.example.com", d);
    expect(r.ok).toBe(false);
    expect([...b.granted].sort()).toEqual(["http://localhost/*", `${NGROK}/*`].sort());
    expect(b.stored.get("serverBaseUrl")).toBe(NGROK);
  });

  test("two options tabs: the second save revokes what is stored now, not what that tab loaded", async () => {
    const b = new FakeBrowser();
    const d = browserSaveDeps(b.permissions, b.storage);
    const X = NGROK;
    const Y = "https://omega.trycloudflare.com";
    const Z = "https://omega.example.com";
    await saveServerBaseUrl(X, d); // both tabs open showing X
    await saveServerBaseUrl(Y, d); // tab A: X → Y
    await saveServerBaseUrl(Z, d); // tab B, still showing X
    expect([...b.granted].sort()).toEqual(["http://localhost/*", `${Z}/*`].sort());
    expect(b.stored.get("serverBaseUrl")).toBe(Z);
  });

  test("a hostile URL never reaches chrome.permissions", async () => {
    const b = new FakeBrowser();
    let prompts = 0;
    const d = browserSaveDeps({ ...b.permissions, request: () => ((prompts += 1), Promise.resolve(true)) }, b.storage);
    for (const bad of ["http://evil.com", "https://user:pw@evil.com", "https://10.0.0.1", "https://evil.com/path"]) {
      expect((await saveServerBaseUrl(bad, d)).ok).toBe(false);
    }
    expect(prompts).toBe(0);
    expect(b.stored.size).toBe(0);
  });
});
