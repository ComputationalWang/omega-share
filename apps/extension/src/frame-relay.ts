import * as v from "valibot";
import {
  BRIDGE_SOURCE,
  type ExtensionToPage,
  GenericHostSchema,
  FrameIntentMessageSchema,
  FrameLostMessageSchema,
  FrameStateMessageSchema,
  PageToExtensionSchema,
} from "@omega/shared/extension-bridge";

/**
 * Frame sync (ADR 0057 §3, §5): the background's half. The room page asks, through the bridge, to attach the frame
 * script to the host its tab unlocked; this injects it, passes the page's commands to the frame and the frame's
 * reports to the page, and detaches it. Frame and page never talk directly.
 *
 * Nested player hosts (OME-2521, ADR 0057 amendment): when the unlocked page's video sits in another host's iframe,
 * the viewer is asked once (the consent page with `parent`) to let that host's frames be synced for this one. The
 * pairs they allowed live in `storage.local` under NESTED_HOSTS_KEY; frames of those hosts report for the unlocked host.
 */

/** The browser calls this needs; injected so it can be tested without a browser. */
export interface FrameRelayDeps {
  /** The server origin the user set (or the default). */
  readonly ourOrigin: () => Promise<string>;
  /** The host the tab's live unlock rules are for, if any (`unlocker.unlockedHost`). */
  readonly unlockedHost: (tabId: number) => Promise<string | undefined>;
  /** `scripting.executeScript` of `frameSync` with `host` and its allowed nested hosts into every frame of the tab we have access to. */
  readonly inject: (tabId: number, host: string, nested: readonly string[]) => Promise<void>;
  /** `tabs.sendMessage` to one frame, or to all of the tab's frames when `frameId` is undefined. */
  readonly toFrames: (tabId: number, message: unknown, frameId: number | undefined) => Promise<void>;
  /** Sends an extension → page message to the bridge in the tab's top frame. */
  readonly notify: (tabId: number, message: ExtensionToPage) => Promise<void>;
  /** The extension's consent page URL (`runtime.getURL("/consent.html")`). */
  readonly consentUrl: string;
  /** Whether the viewer allowed `host` (unlock.ts `hasConsent`). */
  readonly hasAccess: (host: string) => Promise<boolean>;
  /** The nested hosts the viewer allowed for `host` (`nestedOf` the stored pairs). */
  readonly nestedHosts: (host: string) => Promise<string[]>;
  /** Records that the viewer allowed `nested` for `host`. */
  readonly allowNested: (host: string, nested: string) => Promise<void>;
  /** Opens the consent page for `nested`, framed by `host` in the room tab. */
  readonly askNested: (tabId: number, host: string, nested: string) => Promise<void>;
}

/** `storage.local` key: `{ [unlocked host]: nested hosts the viewer allowed for it }` (OME-2521). */
export const NESTED_HOSTS_KEY = "nestedHosts";

/** The nested hosts allowed for `host`. */
export function nestedOf(stored: unknown, host: string): string[] {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return [];
  const list: unknown = (stored as Record<string, unknown>)[host];
  return Array.isArray(list) ? list.filter((h): h is string => typeof h === "string") : [];
}

/** The stored pairs with `nested` added (once) under `host`. */
export function withNested(stored: unknown, host: string, nested: string): Record<string, string[]> {
  const pairs = typeof stored === "object" && stored !== null && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
  const all: Record<string, string[]> = {};
  for (const key of Object.keys(pairs)) all[key] = nestedOf(pairs, key);
  all[host] = [...new Set([...nestedOf(pairs, host), nested])];
  return all;
}

/** The subset of `runtime.MessageSender` this reads. Firefox has no `origin`. */
export interface FrameSender {
  readonly url?: string | undefined;
  readonly origin?: string | undefined;
  readonly frameId?: number | undefined;
  readonly tab?: { readonly id?: number | undefined; readonly url?: string | undefined } | undefined;
}

const FrameToExtensionSchema = v.variant("kind", [FrameStateMessageSchema, FrameIntentMessageSchema, FrameLostMessageSchema]);
const DETACH = { source: BRIDGE_SOURCE, kind: "frame-detach" } as const;
/** Frame → extension only: the unlocked frame has no video, and this is its largest player iframe's host. */
const FrameNestedSchema = v.strictObject({ source: v.literal(BRIDGE_SOURCE), kind: v.literal("frame-nested"), host: GenericHostSchema, nested: GenericHostSchema });
/** The consent page's answer for a nested host; unlock.ts takes the one without `parent`. */
const NestedConsentSchema = v.strictObject({
  source: v.literal(BRIDGE_SOURCE),
  kind: v.literal("consent"),
  tabId: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  host: GenericHostSchema,
  parent: GenericHostSchema,
});

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

export function createFrameRelay(deps: FrameRelayDeps) {
  // The frame that reported first, per tab. Lost on a background restart; commands then go to every frame meanwhile.
  const pinned = new Map<number, number>();
  // Asked this background's lifetime, so a refusal isn't asked again on every attach.
  const asked = new Set<string>();

  async function detach(tabId: number): Promise<void> {
    pinned.delete(tabId);
    await deps.toFrames(tabId, DETACH, undefined);
  }

  async function fromPage(tabId: number, raw: unknown): Promise<void> {
    const parsed = v.safeParse(PageToExtensionSchema, raw);
    if (!parsed.success) return;
    const message = parsed.output;
    if (message.kind === "unlock" || message.kind === "relock") return detach(tabId);
    if ((await deps.unlockedHost(tabId)) !== message.host) return;
    if (message.kind === "frame-command") return deps.toFrames(tabId, message, pinned.get(tabId));
    await detach(tabId);
    await inject(tabId, message.host);
  }

  async function inject(tabId: number, host: string): Promise<void> {
    await deps.inject(tabId, host, await deps.nestedHosts(host)).catch(() => undefined);
  }

  async function onNested(tabId: number, host: string, nested: string): Promise<void> {
    if (nested === host || nested === new URL(await deps.ourOrigin()).hostname) return;
    if ((await deps.nestedHosts(host)).includes(nested) && (await deps.hasAccess(nested))) return;
    const key = `${String(tabId)} ${host} ${nested}`;
    if (asked.has(key)) return;
    asked.add(key);
    await deps.askNested(tabId, host, nested);
  }

  async function fromConsent(raw: unknown): Promise<void> {
    const parsed = v.safeParse(NestedConsentSchema, raw);
    if (!parsed.success) return;
    const { tabId, host, parent } = parsed.output;
    if (host === parent || (await deps.unlockedHost(tabId)) !== parent || !(await deps.hasAccess(host))) return;
    await deps.allowNested(parent, host);
    // The frames are already there: sync them now (the room still attaches it if its attach hasn't timed out).
    await inject(tabId, parent);
  }

  async function fromFrame(tabId: number, frameId: number, origin: string | undefined, raw: unknown): Promise<void> {
    const nested = v.safeParse(FrameNestedSchema, raw);
    if (nested.success) {
      const { host } = nested.output;
      if (origin === `https://${host}` && (await deps.unlockedHost(tabId)) === host) await onNested(tabId, host, nested.output.nested);
      return;
    }
    const parsed = v.safeParse(FrameToExtensionSchema, raw);
    if (!parsed.success) return;
    const message = parsed.output;
    if ((await deps.unlockedHost(tabId)) !== message.host) return;
    if (origin !== `https://${message.host}` && !(await deps.nestedHosts(message.host)).some((h) => origin === `https://${h}`)) return;
    const pin = pinned.get(tabId);
    if (pin !== undefined && pin !== frameId) return;
    if (message.kind === "frame-lost") pinned.delete(tabId);
    else pinned.set(tabId, frameId);
    await deps.notify(tabId, message);
  }

  return {
    /** Every `runtime.onMessage`: the room page's top frame, or a frame script in one of its frames. */
    async onMessage(raw: unknown, sender: FrameSender): Promise<void> {
      if (sender.url?.startsWith(deps.consentUrl) === true) return fromConsent(raw);
      const tabId = sender.tab?.id;
      const frameId = sender.frameId;
      if (tabId === undefined || frameId === undefined) return;
      if (frameId !== 0) return fromFrame(tabId, frameId, sender.origin ?? originOf(sender.url), raw);
      if (originOf(sender.tab?.url) === (await deps.ourOrigin())) await fromPage(tabId, raw);
    },
    /** The tab closed or loaded a new page: its frames are gone. */
    tabGone(tabId: number): void {
      pinned.delete(tabId);
    },
  };
}
