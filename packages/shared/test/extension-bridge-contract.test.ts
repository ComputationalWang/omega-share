import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  BRIDGE_SOURCE,
  ExtensionToPageSchema,
  GenericHostSchema,
  PageToExtensionSchema,
  UNLOCK_RULE_COUNT,
  type UnlockRule,
  unlockRules,
} from "@omega/shared/extension-bridge";

const ok = (s: v.GenericSchema, x: unknown) => v.safeParse(s, x).success;

describe("page → extension", () => {
  test("accepts unlock and relock", () => {
    expect(v.parse(PageToExtensionSchema, { source: BRIDGE_SOURCE, kind: "unlock", host: "kwik.cx" })).toEqual({
      source: "omega-share",
      kind: "unlock",
      host: "kwik.cx",
    });
    expect(ok(PageToExtensionSchema, { source: "omega-share", kind: "relock" })).toBe(true);
  });

  test.each([
    ["unknown kind", { source: "omega-share", kind: "grant", host: "kwik.cx" }],
    ["extension-side kind", { source: "omega-share", kind: "present", version: "1.0.0" }],
    ["wrong source", { source: "other", kind: "relock" }],
    ["no source", { kind: "relock" }],
    ["extra key", { source: "omega-share", kind: "relock", host: "kwik.cx" }],
    ["unlock without host", { source: "omega-share", kind: "unlock" }],
    ["host not a string", { source: "omega-share", kind: "unlock", host: 1 }],
    ["not an object", "unlock"],
    ["null", null],
  ])("rejects %s", (_, msg) => {
    expect(ok(PageToExtensionSchema, msg)).toBe(false);
  });
});

describe("extension → page", () => {
  test("accepts present and every unlock-result outcome", () => {
    expect(ok(ExtensionToPageSchema, { source: "omega-share", kind: "present", version: "0.4.2" })).toBe(true);
    for (const outcome of ["unlocked", "denied", "unsupported"]) {
      expect(ok(ExtensionToPageSchema, { source: "omega-share", kind: "unlock-result", host: "kwik.cx", outcome })).toBe(true);
    }
  });

  test.each([
    ["unknown outcome", { source: "omega-share", kind: "unlock-result", host: "kwik.cx", outcome: "maybe" }],
    ["page-side kind", { source: "omega-share", kind: "unlock", host: "kwik.cx" }],
    ["bad host", { source: "omega-share", kind: "unlock-result", host: "127.0.0.1", outcome: "unlocked" }],
    ["version not dotted numbers", { source: "omega-share", kind: "present", version: "<img>" }],
    ["version too long", { source: "omega-share", kind: "present", version: "1.2.3.4.5" }],
    ["wrong source", { source: "omega", kind: "present", version: "1.0" }],
  ])("rejects %s", (_, msg) => {
    expect(ok(ExtensionToPageSchema, msg)).toBe(false);
  });
});

describe("host follows ADR 0024 §1", () => {
  test.each(["kwik.cx", "player.example-cdn.com", "xn--bcher-kva.de"])("accepts %s", (h) => {
    expect(ok(GenericHostSchema, h)).toBe(true);
  });

  test.each([
    "127.0.0.1",
    "2130706433",
    "[::1]",
    "localhost",
    "foo.local",
    "127.0.0.1.nip.io",
    "www.youtube.com",
    "player.vimeo.com",
    "twitch.tv",
    "KWIK.CX",
    "kwik.cx.",
    "kwik.cx:443",
    "kwik.cx/path",
    "user@kwik.cx",
    "https://kwik.cx",
    "",
    "a".repeat(300) + ".com",
  ])("rejects %s", (h) => {
    expect(ok(GenericHostSchema, h)).toBe(false);
  });
});

describe("unlockRules (ADR 0047 §2/§3)", () => {
  const base = { tabId: 42, ownHost: "omega-share.example.org", host: "kwik.cx", ruleIdBase: 4200 };
  const condition: UnlockRule["condition"] = {
    resourceTypes: ["sub_frame"],
    initiatorDomains: ["omega-share.example.org"],
    requestDomains: ["kwik.cx"],
    tabIds: [42],
  };
  const xfo: UnlockRule = {
    id: 4200,
    priority: 1,
    condition,
    action: { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }] },
  };
  const csp: UnlockRule = {
    id: 4201,
    priority: 1,
    condition: { ...condition, responseHeaders: [{ header: "content-security-policy", values: ["*frame-ancestors*"] }] },
    action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] },
  };
  const referer: UnlockRule = {
    id: 4202,
    priority: 1,
    condition,
    action: { type: "modifyHeaders", requestHeaders: [{ header: "referer", operation: "set", value: "https://kwik.cx/" }] },
  };

  test("both flags off: only the X-Frame-Options rule", () => {
    expect(unlockRules({ ...base, csp: false, referer: false })).toEqual([xfo]);
  });
  test("csp adds exactly the conditional CSP rule", () => {
    expect(unlockRules({ ...base, csp: true, referer: false })).toEqual([xfo, csp]);
  });
  test("referer adds exactly the Referer rule", () => {
    expect(unlockRules({ ...base, csp: false, referer: true })).toEqual([xfo, referer]);
  });
  test("both flags on: all three, ids within ruleIdBase + UNLOCK_RULE_COUNT", () => {
    const rules = unlockRules({ ...base, csp: true, referer: true });
    expect(rules).toEqual([xfo, csp, referer]);
    expect(rules?.every((r) => r.id >= 4200 && r.id < 4200 + UNLOCK_RULE_COUNT)).toBe(true);
  });

  test("ownHost is normalised", () => {
    expect(unlockRules({ ...base, ownHost: "Omega-Share.Example.org.", csp: false, referer: false })?.[0]?.condition.initiatorDomains).toEqual([
      "omega-share.example.org",
    ]);
  });

  test.each([
    ["generic-rule host", { host: "127.0.0.1" }],
    ["synced-provider host", { host: "www.youtube.com" }],
    ["our own host", { host: "omega-share.example.org" }],
    ["a subdomain of our own host", { host: "cdn.omega-share.example.org" }],
    ["bad ownHost", { ownHost: "a/b" }],
    ["no tab (TAB_ID_NONE)", { tabId: -1 }],
    ["fractional tab id", { tabId: 1.5 }],
    ["rule id 0", { ruleIdBase: 0 }],
    ["fractional rule id", { ruleIdBase: 2.5 }],
  ])("null for %s", (_, bad) => {
    expect(unlockRules({ ...base, ...bad, csp: true, referer: true })).toBeNull();
  });
});
