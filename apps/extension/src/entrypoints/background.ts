import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { bridgeMatches } from "../bridge";
import { DEFAULT_SERVER_BASE_URL, SERVER_BASE_URL_KEY, readServerBaseUrl } from "../settings";
import { FOUND_ORIGINS, actionState, parseFoundMessage, syncFound } from "../found";
import { UNLOCK_HOSTS_KEY, createUnlocker, hasConsent, unlockPermissions, withoutRevoked } from "../unlock";

const BRIDGE_ID = "omega-bridge";
const BROWSER = import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome";

/** Registers the ADR 0047 bridge on our origin(s): the default, plus the stored self-hosted one when it is granted. */
async function syncBridge(): Promise<void> {
  const stored = (await browser.storage.local.get(SERVER_BASE_URL_KEY))[SERVER_BASE_URL_KEY];
  const matches: string[] = [];
  for (const pattern of bridgeMatches(DEFAULT_SERVER_BASE_URL, stored)) {
    if (await browser.permissions.contains({ origins: [pattern] })) matches.push(pattern);
  }
  await browser.scripting.unregisterContentScripts({ ids: [BRIDGE_ID] }).catch(() => undefined);
  if (matches.length === 0) return;
  await browser.scripting.registerContentScripts([
    { id: BRIDGE_ID, js: ["content-scripts/bridge.js"], matches, runAt: "document_idle", persistAcrossSessions: false },
  ]);
}

// One at a time: saving a server fires permissions.onAdded and storage.onChanged together, and two overlapping
// unregister/register pairs would fail on the duplicate id and leave the old matches.
let bridgeQueue: Promise<void> = Promise.resolve();
function registerBridge(): void {
  bridgeQueue = bridgeQueue.then(syncBridge).catch(() => undefined);
}

/** The found indicator (OME-1042): its content script while https://*\/* is granted; otherwise none and idle icons. */
async function syncFoundScript(): Promise<void> {
  const ours = bridgeMatches(DEFAULT_SERVER_BASE_URL, (await browser.storage.local.get(SERVER_BASE_URL_KEY))[SERVER_BASE_URL_KEY]);
  await syncFound(
    {
      granted: () => browser.permissions.contains({ origins: [...FOUND_ORIGINS] }),
      register: (script) => browser.scripting.registerContentScripts([script]),
      unregister: (id) => browser.scripting.unregisterContentScripts({ ids: [id] }),
      resetIcons: async () => {
        for (const tab of await browser.tabs.query({})) if (tab.id !== undefined) await setAction(tab.id, 0);
      },
    },
    ours,
  );
}

async function setAction(tabId: number, count: number): Promise<void> {
  const { path, title, badge } = actionState(count);
  await Promise.all([browser.action.setIcon({ tabId, path }), browser.action.setTitle({ tabId, title }), browser.action.setBadgeText({ tabId, text: badge })]).catch(() => undefined);
}

let foundQueue: Promise<void> = Promise.resolve();
function registerFound(): void {
  foundQueue = foundQueue.then(syncFoundScript).catch(() => undefined);
}

// Event-driven: Chrome runs it as a service worker, Firefox as a non-persistent event page. The popup does the
// sharing; this owns the "Unlock with extension" session rules (ADR 0047) and the bridge that asks for them.
export default defineBackground(() => {
  const unlocker = createUnlocker({
    browser: BROWSER,
    consentUrl: browser.runtime.getURL("/consent.html"),
    version: browser.runtime.getManifest().version,
    ourOrigin: async () => readServerBaseUrl((await browser.storage.local.get(SERVER_BASE_URL_KEY))[SERVER_BASE_URL_KEY]),
    dnr: () => browser.declarativeNetRequest,
    hasAccess: async (host) =>
      hasConsent(
        {
          hostGranted: await browser.permissions.contains(unlockPermissions(host)),
          everyHostGranted: await browser.permissions.contains({ origins: [...FOUND_ORIGINS] }),
          stored: (await browser.storage.local.get(UNLOCK_HOSTS_KEY))[UNLOCK_HOSTS_KEY],
        },
        host,
      ),
    openConsent: async (tabId, host) => {
      const query = new URLSearchParams({ tabId: String(tabId), host });
      await browser.tabs.create({ url: `${browser.runtime.getURL("/consent.html")}?${query.toString()}` });
    },
    tabUrl: (tabId) => browser.tabs.get(tabId).then((tab) => tab.url, () => undefined),
    notify: async (tabId, message) => {
      await browser.tabs.sendMessage(tabId, message, { frameId: 0 }).catch(() => undefined);
    },
  });

  browser.runtime.onMessage.addListener((message, sender) => {
    // The found content script runs in top frames only and sends just a count.
    const count = parseFoundMessage(message);
    if (count !== null) {
      if (sender.tab?.id !== undefined && sender.frameId === 0) void setAction(sender.tab.id, count);
      return;
    }
    void unlocker.onMessage(message, sender);
  });
  browser.tabs.onRemoved.addListener((tabId) => void unlocker.tabRemoved(tabId));
  // A tab URL we can't see (no host access) isn't ours, so its rules go too.
  browser.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === "loading" || change.url !== undefined) void unlocker.tabUpdated(tabId, tab.url);
    // A new page starts idle; its found script (if any) reports again at document_idle.
    if (change.status === "loading") void setAction(tabId, 0);
  });

  browser.runtime.onInstalled.addListener(registerBridge);
  browser.runtime.onStartup.addListener(registerBridge);
  browser.permissions.onAdded.addListener(registerBridge);
  browser.runtime.onInstalled.addListener(registerFound);
  browser.runtime.onStartup.addListener(registerFound);
  browser.permissions.onAdded.addListener(registerFound);
  browser.permissions.onRemoved.addListener((removed) => {
    registerFound();
    void browser.storage.local.get(UNLOCK_HOSTS_KEY).then((items) =>
      browser.storage.local.set({ [UNLOCK_HOSTS_KEY]: withoutRevoked(items[UNLOCK_HOSTS_KEY], removed.origins ?? []) }),
    );
  });
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && SERVER_BASE_URL_KEY in changes) {
      registerBridge();
      registerFound();
    }
  });

  // e2e builds only (compiled out of store builds; the manifest test checks): Firefox's BiDi can't open a
  // moz-extension:// URL, so the Firefox lane (OME-593, e2e/support/firefox.ts) sets `#omega-e2e-popup=<server URL>`
  // on the target tab and this opens the popup for it, like the Chromium harness's `?tabId=`. The key is settings.ts's
  // SERVER_BASE_URL_KEY.
  if (import.meta.env.MODE === "e2e") {
    browser.tabs.onUpdated.addListener((tabId, change) => {
      if (change.url === undefined) return;
      const server = new URLSearchParams(new URL(change.url).hash.slice(1)).get("omega-e2e-popup");
      if (server === null) return;
      void browser.storage.local.set({ serverBaseUrl: server }).then(() => browser.tabs.create({ url: `${browser.runtime.getURL("/popup.html")}?tabId=${String(tabId)}` }));
    });
  }
});
