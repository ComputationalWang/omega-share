import { describe, expect, test } from "bun:test";
import type { ExtensionToPage, UnlockRule } from "@omega/shared/extension-bridge";
import { type UnlockDeps, createUnlocker, unlockPermissions } from "../src/unlock";

// ADR 0047 §2 and §5 (OME-1040): session rules for one host in one room tab, the consent hop, and removal.
const OUR = "https://omega.example";
const CONSENT = "chrome-extension://abc/consent.html";
const ROOM_TAB = 7;
const INT32_MAX = 2 ** 31 - 1;

/** The session rule store as Chromium keeps it: one atomic update, int32 ids, no duplicates. */
function fakeDnr() {
  let rules: UnlockRule[] = [];
  return {
    rules: () => rules,
    getSessionRules: () => Promise.resolve(structuredClone(rules)),
    updateSessionRules: (u: { removeRuleIds?: number[]; addRules?: UnlockRule[] }) => {
      const kept = rules.filter((r) => !(u.removeRuleIds ?? []).includes(r.id));
      const next = [...kept, ...(u.addRules ?? [])];
      const ids = next.map((r) => r.id);
      if ([...ids, ...(u.removeRuleIds ?? [])].some((id) => !Number.isInteger(id) || id < 1 || id > INT32_MAX)) return Promise.reject(new Error("expected integer"));
      if (new Set(ids).size !== ids.length) return Promise.reject(new Error("duplicate id"));
      rules = next;
      return Promise.resolve();
    },
  };
}

function harness(opts: Partial<Omit<UnlockDeps, "tabUrl">> & { granted?: boolean; tabUrl?: string | undefined; noDnr?: boolean } = {}) {
  const { granted = false, noDnr = false, tabUrl, ...over } = opts;
  const url = "tabUrl" in opts ? tabUrl : `${OUR}/r/lobby`;
  const dnr = fakeDnr();
  const consents: [number, string][] = [];
  const notes: [number, ExtensionToPage][] = [];
  const deps: UnlockDeps = {
    browser: "chrome",
    consentUrl: CONSENT,
    version: "0.1.1",
    ourOrigin: () => Promise.resolve(OUR),
    dnr: () => (noDnr ? undefined : dnr),
    hasAccess: () => Promise.resolve(granted),
    openConsent: (tabId, host) => (consents.push([tabId, host]), Promise.resolve()),
    tabUrl: () => Promise.resolve(url),
    notify: (tabId, msg) => (notes.push([tabId, msg]), Promise.resolve()),
    ...over,
  };
  return { unlocker: createUnlocker(deps), rules: dnr.rules, consents, notes };
}

const roomSender = { tab: { id: ROOM_TAB, url: `${OUR}/r/lobby` }, frameId: 0, url: `${OUR}/r/lobby` };
const unlock = (host: string) => ({ source: "omega-share", kind: "unlock", host });

const xfoRule = (id: number, tab = ROOM_TAB) => ({
  id,
  priority: 1,
  condition: { resourceTypes: ["sub_frame"], initiatorDomains: ["omega.example"], requestDomains: ["video.cdn-host.net"], tabIds: [tab] },
  action: { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }] },
});
const cspRule = (id: number, tab = ROOM_TAB) => ({
  id,
  priority: 1,
  condition: {
    resourceTypes: ["sub_frame"],
    initiatorDomains: ["omega.example"],
    requestDomains: ["video.cdn-host.net"],
    tabIds: [tab],
    responseHeaders: [{ header: "content-security-policy", values: ["*frame-ancestors*"] }],
  },
  action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] },
});

describe("unlockPermissions", () => {
  test("Chromium asks for the DNR API permission with the one host; Firefox for the host alone (§4)", () => {
    expect(unlockPermissions("video.cdn-host.net", "chrome")).toEqual({ permissions: ["declarativeNetRequestWithHostAccess"], origins: ["https://video.cdn-host.net/*"] });
    expect(unlockPermissions("video.cdn-host.net", "firefox")).toEqual({ permissions: [], origins: ["https://video.cdn-host.net/*"] });
  });
});

describe("unlock from the room page", () => {
  test("a granted host gets the XFO and frame-ancestors CSP rules in Chromium, replacing the tab's set", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.rules()).toEqual([xfoRule(1), cspRule(2)]);
    expect(h.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unlocked" }]]);
    expect(h.consents).toEqual([]);
  });

  test("one set per tab: unlocking again replaces it, another tab gets its own", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), { ...roomSender, tab: { id: 8, url: `${OUR}/r/two` } });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.rules().filter((r) => r.condition.tabIds[0] === ROOM_TAB)).toHaveLength(2);
    expect(h.rules().filter((r) => r.condition.tabIds[0] === 8)).toHaveLength(2);
    expect(new Set(h.rules().map((r) => r.id)).size).toBe(4);
  });

  test("Chromium's large tab ids still get valid int32 rule ids", async () => {
    const h = harness({ granted: true });
    const big = { ...roomSender, tab: { id: 1156176314, url: `${OUR}/r/lobby` } };
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), big);
    expect(h.rules()).toEqual([xfoRule(1, 1156176314), cspRule(2, 1156176314)]);
    await h.unlocker.tabRemoved(1156176314);
    expect(h.rules()).toEqual([]);
  });

  test("Firefox gets the XFO rule only: no responseHeaders condition there, so no CSP rule (§2)", async () => {
    const h = harness({ granted: true, browser: "firefox" });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.rules()).toEqual([xfoRule(1)]);
  });

  test("an ungranted host opens the consent page and adds no rules yet", async () => {
    const h = harness();
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.consents).toEqual([[ROOM_TAB, "video.cdn-host.net"]]);
    expect(h.rules()).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  test("a message from a tab off our origin, a subframe or a malformed body is ignored", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), { ...roomSender, tab: { id: ROOM_TAB, url: "https://evil.example/r/lobby" } });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), { ...roomSender, frameId: 3 });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), { frameId: 0, url: `${OUR}/r/lobby` });
    await h.unlocker.onMessage({ source: "omega-share", kind: "unlock", host: "127.0.0.1" }, roomSender);
    await h.unlocker.onMessage({ source: "omega-share", kind: "unlock", host: "omega.example" }, roomSender);
    await h.unlocker.onMessage({ kind: "unlock", host: "video.cdn-host.net" }, roomSender);
    expect(h.rules()).toEqual([]);
    expect(h.consents).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  test("relock removes the tab's rule set and leaves other tabs'", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), { ...roomSender, tab: { id: 8, url: `${OUR}/r/two` } });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    await h.unlocker.onMessage({ source: "omega-share", kind: "relock" }, roomSender);
    expect(h.rules()).toEqual([xfoRule(1, 8), cspRule(2, 8)]);
  });

  test("without the DNR API (Chromium before the grant) or when rules fail, the page hears unsupported", async () => {
    const noApi = harness({ granted: true, noDnr: true });
    await noApi.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(noApi.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unsupported" }]]);
    const failing = harness({ granted: true, dnr: () => ({ getSessionRules: () => Promise.resolve([]), updateSessionRules: () => Promise.reject(new Error("quota")) }) });
    await failing.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(failing.notes.map(([, m]) => m)).toEqual([{ source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unsupported" }]);
  });
});

describe("answer from the consent page", () => {
  const consent = (tabId: number, host: string) => ({ source: "omega-share", kind: "consent", tabId, host });
  const consentSender = { url: `${CONSENT}?tabId=7&host=video.cdn-host.net`, tab: { id: 99, url: `${CONSENT}?tabId=7&host=video.cdn-host.net` } };

  test("once granted, the rules go on the room tab that asked and it hears unlocked", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    expect(h.rules()).toEqual([xfoRule(1), cspRule(2)]);
    expect(h.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unlocked" }]]);
  });

  test("not granted (Deny, or the prompt refused) tells the room tab denied", async () => {
    const h = harness({ granted: false });
    await h.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    expect(h.rules()).toEqual([]);
    expect(h.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "denied" }]]);
  });

  test("a consent claim from anywhere but the consent page, or for a tab that left our origin, does nothing", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), roomSender);
    const moved = harness({ granted: true, tabUrl: "https://elsewhere.example/" });
    await moved.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    const gone = harness({ granted: true, tabUrl: undefined });
    await gone.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    expect([...h.rules(), ...moved.rules(), ...gone.rules()]).toEqual([]);
    expect([...h.notes, ...moved.notes, ...gone.notes]).toEqual([]);
  });
});

describe("removal", () => {
  const unlocked = async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.rules()).toHaveLength(2);
    return h;
  };

  test("a tab that stays on our origin keeps its set", async () => {
    const h = await unlocked();
    await h.unlocker.tabUpdated(ROOM_TAB, `${OUR}/r/other`);
    expect(h.rules()).toHaveLength(2);
  });

  test("a tab that navigates off our origin, or to a URL we can't see, loses its set", async () => {
    for (const url of ["https://elsewhere.example/", undefined]) {
      const h = await unlocked();
      await h.unlocker.tabUpdated(ROOM_TAB, url);
      expect(h.rules()).toEqual([]);
    }
  });

  test("a closed tab loses its set", async () => {
    const h = await unlocked();
    await h.unlocker.tabRemoved(ROOM_TAB);
    expect(h.rules()).toEqual([]);
  });

  test("without the DNR API there is nothing to remove", async () => {
    const h = harness({ noDnr: true });
    await h.unlocker.tabRemoved(ROOM_TAB);
    expect(h.rules()).toEqual([]);
  });
});
