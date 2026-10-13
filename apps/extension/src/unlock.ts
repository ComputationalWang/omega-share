import * as v from "valibot";
import {
  BRIDGE_SOURCE,
  GenericHostSchema,
  PageToExtensionSchema,
  type ExtensionToPage,
  type UnlockOutcome,
  type UnlockRule,
  unlockRules,
} from "@omega/shared/extension-bridge";

/**
 * "Unlock with extension" (ADR 0047 §2, §5): the background's half. A room page on our origin asks, through the
 * bridge content script, to unlock one generic host; this installs DNR session rules for that host in that tab only,
 * after the consent page when the host isn't granted yet, and removes them again.
 */

export type UnlockBrowser = "chrome" | "firefox";

/** The browser calls this needs; injected so it can be tested without a browser. */
export interface UnlockDeps {
  readonly browser: UnlockBrowser;
  /** The extension's consent page URL (`runtime.getURL("/consent.html")`). */
  readonly consentUrl: string;
  /** The manifest version, for `present`. */
  readonly version: string;
  /** The server origin the user set (or the default). */
  readonly ourOrigin: () => Promise<string>;
  /** `browser.declarativeNetRequest`, or undefined where the API is absent (Chromium before the grant). */
  readonly dnr: () => SessionRules | undefined;
  /** `permissions.contains(unlockPermissions(host))` */
  readonly hasAccess: (host: string) => Promise<boolean>;
  /** Opens the consent page for the room tab that asked. */
  readonly openConsent: (tabId: number, host: string) => Promise<void>;
  /** The tab's URL, or undefined when it's gone or not ours to see. */
  readonly tabUrl: (tabId: number) => Promise<string | undefined>;
  /** Sends an extension → page message to the bridge in the tab's top frame. */
  readonly notify: (tabId: number, message: ExtensionToPage) => Promise<void>;
}

/** The subset of `browser.declarativeNetRequest` this uses. Every session rule is ours. */
export interface SessionRules {
  getSessionRules(): Promise<{ id: number; condition: { tabIds?: number[] | undefined } }[]>;
  updateSessionRules(options: { removeRuleIds?: number[]; addRules?: UnlockRule[] }): Promise<void>;
}

/** The subset of `runtime.MessageSender` this reads. */
export interface Sender {
  readonly url?: string | undefined;
  readonly frameId?: number | undefined;
  readonly tab?: { readonly id?: number | undefined; readonly url?: string | undefined } | undefined;
}

/** What the consent page sends after its Allow or Not now button; the grant itself is re-checked, never trusted. */
const ConsentMessageSchema = v.strictObject({
  source: v.literal(BRIDGE_SOURCE),
  kind: v.literal("consent"),
  tabId: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  host: GenericHostSchema,
});
export type ConsentMessage = v.InferOutput<typeof ConsentMessageSchema>;

/** One host's permissions (§4): Chromium asks for the optional DNR permission with it; Firefox holds that at install. */
export function unlockPermissions(host: string, browser: UnlockBrowser): { permissions: "declarativeNetRequestWithHostAccess"[]; origins: string[] } {
  return { permissions: browser === "chrome" ? ["declarativeNetRequestWithHostAccess"] : [], origins: [`https://${host}/*`] };
}

/**
 * The tab's current rule ids, and a free block for a new set. Tab ids don't fit DNR's int32 rule ids (Chromium's can
 * pass a billion), so a set is found by its `tabIds` condition and new ids follow the highest one in use.
 */
async function ruleSlots(dnr: SessionRules, tabId: number): Promise<{ ids: number[]; base: number }> {
  const rules = await dnr.getSessionRules();
  const ids = rules.filter((r) => r.condition.tabIds?.includes(tabId) === true).map((r) => r.id);
  const others = rules.filter((r) => !ids.includes(r.id)).map((r) => r.id);
  return { ids, base: Math.max(0, ...others) + 1 };
}

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function createUnlocker(deps: UnlockDeps) {
  const result = (host: string, outcome: UnlockOutcome): ExtensionToPage => ({ source: BRIDGE_SOURCE, kind: "unlock-result", host, outcome });

  async function remove(tabId: number): Promise<void> {
    const dnr = deps.dnr();
    if (dnr === undefined) return;
    const { ids } = await ruleSlots(dnr, tabId);
    if (ids.length > 0) await dnr.updateSessionRules({ removeRuleIds: ids });
  }

  async function install(tabId: number, host: string): Promise<UnlockOutcome> {
    const dnr = deps.dnr();
    if (dnr === undefined) return "unsupported";
    const ownHost = new URL(await deps.ourOrigin()).hostname;
    try {
      const { ids, base } = await ruleSlots(dnr, tabId);
      // Referer (§3) waits for board sign-off (OME-1055).
      const rules = unlockRules({ tabId, ownHost, host, ruleIdBase: base, csp: deps.browser === "chrome", referer: false });
      if (rules === null) return "unsupported";
      // One atomic update: the tab's old set goes as its new one comes in.
      await dnr.updateSessionRules({ removeRuleIds: ids, addRules: rules });
      return "unlocked";
    } catch {
      return "unsupported";
    }
  }

  async function onTabOfOurs(tabId: number): Promise<boolean> {
    return originOf(await deps.tabUrl(tabId)) === (await deps.ourOrigin());
  }

  return {
    /** Every `runtime.onMessage`: bridge messages from our room tabs, and the consent page's answer. */
    async onMessage(raw: unknown, sender: Sender): Promise<void> {
      if (sender.url?.startsWith(deps.consentUrl) === true) {
        const consent = v.safeParse(ConsentMessageSchema, raw);
        if (!consent.success) return;
        const { tabId, host } = consent.output;
        if (!(await onTabOfOurs(tabId))) return;
        const outcome = (await deps.hasAccess(host)) ? await install(tabId, host) : "denied";
        await deps.notify(tabId, result(host, outcome));
        return;
      }
      const tabId = sender.tab?.id;
      if (tabId === undefined || sender.frameId !== 0 || originOf(sender.tab?.url) !== (await deps.ourOrigin())) return;
      const message = v.safeParse(PageToExtensionSchema, raw);
      if (!message.success) return;
      if (message.output.kind === "relock") {
        await remove(tabId);
        return;
      }
      const { host } = message.output;
      if (!(await deps.hasAccess(host))) {
        await deps.openConsent(tabId, host);
        return;
      }
      await deps.notify(tabId, result(host, await install(tabId, host)));
    },
    /** `tabs.onUpdated` with a new URL; undefined means we can't see it, so it isn't ours. */
    async tabUpdated(tabId: number, url: string | undefined): Promise<void> {
      if (originOf(url) === (await deps.ourOrigin())) return;
      await remove(tabId);
    },
    tabRemoved: remove,
  };
}
