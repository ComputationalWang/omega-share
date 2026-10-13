import { describe, expect, test } from "bun:test";
import type { ExtensionToPage } from "@omega/shared/extension-bridge";
import { type UnlockDeps, createUnlocker, unlockPermissions } from "../src/unlock";

// ADR 0047 §2 and §5 (OME-1040): session rules for one host in one room tab, the consent hop, and removal.
const OUR = "https://omega.example";
const CONSENT = "chrome-extension://abc/consent.html";
const ROOM_TAB = 7;

interface Update {
  removeRuleIds?: number[];
  addRules?: unknown[];
}

function harness(opts: Partial<Omit<UnlockDeps, "tabUrl">> & { granted?: boolean; tabUrl?: string | undefined; noDnr?: boolean } = {}) {
  const { granted = false, noDnr = false, tabUrl, ...over } = opts;
  const url = "tabUrl" in opts ? tabUrl : `${OUR}/r/lobby`;
  const updates: Update[] = [];
  const consents: [number, string][] = [];
  const notes: [number, ExtensionToPage][] = [];
  const deps: UnlockDeps = {
    browser: "chrome",
    consentUrl: CONSENT,
    version: "0.1.1",
    ourOrigin: () => Promise.resolve(OUR),
    dnr: () => (noDnr ? undefined : { updateSessionRules: (u: Update) => (updates.push(u), Promise.resolve()) }),
    hasAccess: () => Promise.resolve(granted),
    openConsent: (tabId, host) => (consents.push([tabId, host]), Promise.resolve()),
    tabUrl: () => Promise.resolve(url),
    notify: (tabId, msg) => (notes.push([tabId, msg]), Promise.resolve()),
    ...over,
  };
  return { unlocker: createUnlocker(deps), updates, consents, notes };
}

const roomSender = { tab: { id: ROOM_TAB, url: `${OUR}/r/lobby` }, frameId: 0, url: `${OUR}/r/lobby` };
const unlock = (host: string) => ({ source: "omega-share", kind: "unlock", host });

const xfoRule = (id: number) => ({
  id,
  priority: 1,
  condition: { resourceTypes: ["sub_frame"], initiatorDomains: ["omega.example"], requestDomains: ["video.cdn-host.net"], tabIds: [ROOM_TAB] },
  action: { type: "modifyHeaders", responseHeaders: [{ header: "x-frame-options", operation: "remove" }] },
});
const cspRule = (id: number) => ({
  id,
  priority: 1,
  condition: {
    resourceTypes: ["sub_frame"],
    initiatorDomains: ["omega.example"],
    requestDomains: ["video.cdn-host.net"],
    tabIds: [ROOM_TAB],
    responseHeaders: [{ header: "content-security-policy", values: ["*frame-ancestors*"] }],
  },
  action: { type: "modifyHeaders", responseHeaders: [{ header: "content-security-policy", operation: "remove" }] },
});
// The tab's rule set: 3 ids from 3 * tabId + 1, so each tab has exactly one set.
const TAB_IDS = [22, 23, 24];

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
    expect(h.updates).toEqual([{ removeRuleIds: TAB_IDS, addRules: [xfoRule(22), cspRule(23)] }]);
    expect(h.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unlocked" }]]);
    expect(h.consents).toEqual([]);
  });

  test("Firefox gets the XFO rule only: no responseHeaders condition there, so no CSP rule (§2)", async () => {
    const h = harness({ granted: true, browser: "firefox" });
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.updates).toEqual([{ removeRuleIds: TAB_IDS, addRules: [xfoRule(22)] }]);
  });

  test("an ungranted host opens the consent page and adds no rules yet", async () => {
    const h = harness();
    await h.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(h.consents).toEqual([[ROOM_TAB, "video.cdn-host.net"]]);
    expect(h.updates).toEqual([]);
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
    expect(h.updates).toEqual([]);
    expect(h.consents).toEqual([]);
    expect(h.notes).toEqual([]);
  });

  test("relock removes the tab's rule set", async () => {
    const h = harness();
    await h.unlocker.onMessage({ source: "omega-share", kind: "relock" }, roomSender);
    expect(h.updates).toEqual([{ removeRuleIds: TAB_IDS }]);
  });

  test("without the DNR API (Chromium before the grant) or when rules fail, the page hears unsupported", async () => {
    const noApi = harness({ granted: true, noDnr: true });
    await noApi.unlocker.onMessage(unlock("video.cdn-host.net"), roomSender);
    expect(noApi.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unsupported" }]]);
    const failing = harness({ granted: true, dnr: () => ({ updateSessionRules: () => Promise.reject(new Error("quota")) }) });
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
    expect(h.updates).toEqual([{ removeRuleIds: TAB_IDS, addRules: [xfoRule(22), cspRule(23)] }]);
    expect(h.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "unlocked" }]]);
  });

  test("not granted (Deny, or the prompt refused) tells the room tab denied", async () => {
    const h = harness({ granted: false });
    await h.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    expect(h.updates).toEqual([]);
    expect(h.notes).toEqual([[ROOM_TAB, { source: "omega-share", kind: "unlock-result", host: "video.cdn-host.net", outcome: "denied" }]]);
  });

  test("a consent claim from anywhere but the consent page, or for a tab that left our origin, does nothing", async () => {
    const h = harness({ granted: true });
    await h.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), roomSender);
    const moved = harness({ granted: true, tabUrl: "https://elsewhere.example/" });
    await moved.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    const gone = harness({ granted: true, tabUrl: undefined });
    await gone.unlocker.onMessage(consent(ROOM_TAB, "video.cdn-host.net"), consentSender);
    expect([...h.updates, ...moved.updates, ...gone.updates]).toEqual([]);
    expect([...h.notes, ...moved.notes, ...gone.notes]).toEqual([]);
  });
});

describe("removal", () => {
  test("a tab that navigates off our origin (or to a URL we can't see) loses its set; staying on our origin keeps it", async () => {
    const h = harness();
    await h.unlocker.tabUpdated(ROOM_TAB, `${OUR}/r/other`);
    await h.unlocker.tabUpdated(ROOM_TAB, "https://elsewhere.example/");
    await h.unlocker.tabUpdated(ROOM_TAB, undefined);
    expect(h.updates).toEqual([{ removeRuleIds: TAB_IDS }, { removeRuleIds: TAB_IDS }]);
  });

  test("a closed tab loses its set", async () => {
    const h = harness();
    await h.unlocker.tabRemoved(ROOM_TAB);
    expect(h.updates).toEqual([{ removeRuleIds: TAB_IDS }]);
  });

  test("without the DNR API there is nothing to remove", async () => {
    const h = harness({ noDnr: true });
    await h.unlocker.tabRemoved(ROOM_TAB);
    expect(h.updates).toEqual([]);
  });
});
