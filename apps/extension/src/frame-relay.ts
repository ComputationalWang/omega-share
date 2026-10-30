import * as v from "valibot";
import {
  BRIDGE_SOURCE,
  type ExtensionToPage,
  FrameIntentMessageSchema,
  FrameLostMessageSchema,
  FrameStateMessageSchema,
  PageToExtensionSchema,
} from "@omega/shared/extension-bridge";

/**
 * Frame sync (ADR 0057 §3, §5): the background's half. The room page asks, through the bridge, to attach the frame
 * script to the host its tab unlocked; this injects it, passes the page's commands to the frame and the frame's
 * reports to the page, and detaches it. Frame and page never talk directly.
 */

/** The browser calls this needs; injected so it can be tested without a browser. */
export interface FrameRelayDeps {
  /** The server origin the user set (or the default). */
  readonly ourOrigin: () => Promise<string>;
  /** The host the tab's live unlock rules are for, if any (`unlocker.unlockedHost`). */
  readonly unlockedHost: (tabId: number) => Promise<string | undefined>;
  /** `scripting.executeScript` of `frameSync` with `host` into every frame of the tab we have access to. */
  readonly inject: (tabId: number, host: string) => Promise<void>;
  /** `tabs.sendMessage` to one frame, or to all of the tab's frames when `frameId` is undefined. */
  readonly toFrames: (tabId: number, message: unknown, frameId: number | undefined) => Promise<void>;
  /** Sends an extension → page message to the bridge in the tab's top frame. */
  readonly notify: (tabId: number, message: ExtensionToPage) => Promise<void>;
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
    await deps.inject(tabId, message.host).catch(() => undefined);
  }

  async function fromFrame(tabId: number, frameId: number, origin: string | undefined, raw: unknown): Promise<void> {
    const parsed = v.safeParse(FrameToExtensionSchema, raw);
    if (!parsed.success) return;
    const message = parsed.output;
    if (origin !== `https://${message.host}` || (await deps.unlockedHost(tabId)) !== message.host) return;
    const pin = pinned.get(tabId);
    if (pin !== undefined && pin !== frameId) return;
    if (message.kind === "frame-lost") pinned.delete(tabId);
    else pinned.set(tabId, frameId);
    await deps.notify(tabId, message);
  }

  return {
    /** Every `runtime.onMessage`: the room page's top frame, or a frame script in one of its frames. */
    async onMessage(raw: unknown, sender: FrameSender): Promise<void> {
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
