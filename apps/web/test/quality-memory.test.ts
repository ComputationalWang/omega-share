import { describe, expect, test } from "bun:test";
import { QUALITY_KEY_PREFIX, qualityMemory } from "../src/controls/quality";

function store(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      m.set(k, v);
    },
  };
}

describe("qualityMemory (this device's quality per provider, OME-599)", () => {
  test("saves and loads per provider under omega.quality.<provider>", () => {
    const s = store();
    const q = qualityMemory(s);
    q.save("twitch", "720p60");
    q.save("vimeo", "1080p");
    expect(QUALITY_KEY_PREFIX).toBe("omega.quality.");
    expect(s.m.get("omega.quality.twitch")).toBe("720p60");
    expect(q.load("twitch")).toBe("720p60");
    expect(q.load("vimeo")).toBe("1080p");
    expect(q.load("youtube")).toBeNull();
  });

  test("stored values are untrusted: empty, overlong or control-character values read as nothing", () => {
    for (const v of ["", "x".repeat(41), "720p\n", "\u0000"]) {
      expect(qualityMemory(store({ "omega.quality.twitch": v })).load("twitch")).toBeNull();
    }
  });

  test("blocked storage never throws: load is null, save is a no-op", () => {
    const boom = {
      getItem: (): string | null => {
        throw new Error("SecurityError");
      },
      setItem: (): void => {
        throw new Error("QuotaExceededError");
      },
    };
    const q = qualityMemory(boom);
    expect(q.load("twitch")).toBeNull();
    expect(() => {
      q.save("twitch", "720p60");
    }).not.toThrow();
  });

  test("a value we'd never store isn't written either", () => {
    const s = store();
    qualityMemory(s).save("twitch", "x".repeat(41));
    expect(s.m.size).toBe(0);
  });
});
