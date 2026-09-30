import { describe, expect, test } from "bun:test";
import { IFRAME_API_URL } from "../src/player/youtube-loader";
import { TWITCH_SDK_URL } from "../src/player/twitch-loader";
import { VIMEO_SDK_URL } from "../src/player/vimeo-loader";
import { createSdkPolicy, SDK_SCRIPT_URLS, sdkScriptUrl } from "../src/player/sdk-policy";

const GOOD = [IFRAME_API_URL, TWITCH_SDK_URL, VIMEO_SDK_URL];
const BAD = [
  "https://evil.example/x.js",
  "https://www.youtube.com/iframe_api?x",
  "https://player.vimeo.com/api/player.js.evil",
  "http://www.youtube.com/iframe_api",
  "",
];

interface FakeOptions {
  createScriptURL(input: string): string;
}

function fakeFactory() {
  const calls: { name: string; options: FakeOptions }[] = [];
  return {
    calls,
    createPolicy(name: string, options: FakeOptions) {
      calls.push({ name, options });
      return { createScriptURL: (s: string) => ({ trusted: options.createScriptURL(s) }) };
    },
  };
}

describe("SDK_SCRIPT_URLS", () => {
  test("is exactly the three loader URLs", () => {
    expect([...SDK_SCRIPT_URLS].sort()).toEqual([...GOOD].sort());
  });
});

describe("createSdkPolicy without Trusted Types", () => {
  const policy = createSdkPolicy(undefined);
  test("passes the allowlisted URLs through as plain strings", () => {
    for (const u of GOOD) expect(policy(u)).toBe(u);
  });
  test("throws for anything else", () => {
    for (const u of BAD) expect(() => policy(u)).toThrow();
  });
  test("a non-factory value falls back the same way", () => {
    for (const f of [{}, { createPolicy: 1 }, null, "x"]) {
      const p = createSdkPolicy(f);
      expect(p(GOOD[0] ?? "")).toBe(GOOD[0] ?? "");
      expect(() => p("https://evil.example/x.js")).toThrow();
    }
  });
});

describe("createSdkPolicy with a factory", () => {
  test("creates the omega-sdk policy once and returns its trusted value", () => {
    const f = fakeFactory();
    const policy = createSdkPolicy(f);
    expect(f.calls.map((c) => c.name)).toEqual(["omega-sdk"]);
    for (const u of GOOD) expect(policy(u)).toEqual({ trusted: u });
    expect(f.calls).toHaveLength(1);
  });
  test("the policy callback throws for non-allowlisted URLs", () => {
    const f = fakeFactory();
    const policy = createSdkPolicy(f);
    for (const u of BAD) expect(() => policy(u)).toThrow();
  });
});

describe("sdkScriptUrl", () => {
  test("allowlisted URLs pass and others throw (no trustedTypes in bun)", () => {
    for (const u of GOOD) expect(sdkScriptUrl(u)).toBe(u);
    expect(() => sdkScriptUrl("https://evil.example/x.js")).toThrow();
  });
});
