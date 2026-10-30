// The page's side of the site ↔ extension bridge (ADR 0047 §5): one `message` listener, installed at startup so the
// extension's one-time `present` isn't missed while the room chunk loads.
import * as v from "valibot";
import { BRIDGE_SOURCE, ExtensionToPageSchema, type ExtensionToPage, type PageToExtension, type UnlockOutcome } from "@omega/shared/extension-bridge";

export interface ExtensionBridge {
  /** Runs `cb` once the extension has announced itself, at once if it already has. One card at a time: replaces the last `cb`. */
  whenPresent(cb: () => void): void;
  /** Asks the extension to unlock `host` (a parsed `GenericEmbed.host`) in this tab; resolves with its answer. */
  unlock(host: string): Promise<UnlockOutcome>;
  /** The embed changed: drops this tab's unlock, if there is or may be one. */
  relock(): void;
  /** ADR 0057 §3: `attach` and `frame-command`, for the frame adapter. */
  toFrame(msg: FrameToExtension): void;
  /** The one frame adapter's listener for `frame-*` messages, replacing the last; the returned off drops it only if it's still the one. */
  onFrame(cb: (m: FrameMessage) => void): () => void;
}

export type FrameToExtension = Extract<PageToExtension, { kind: "attach" | "frame-command" }>;
export type FrameMessage = Extract<ExtensionToPage, { kind: "frame-state" | "frame-intent" | "frame-lost" }>;

/** The bits of `window` the bridge uses. */
export interface BridgePage extends EventTarget {
  readonly location: { readonly origin: string };
  postMessage(msg: PageToExtension, targetOrigin: string): void;
}

export function createExtensionBridge(win: BridgePage): ExtensionBridge {
  let present = false;
  let onPresent: (() => void) | null = null;
  let pending: { host: string; resolve: (o: UnlockOutcome) => void } | null = null;
  let unlocked = false;
  let onFrameMsg: ((m: FrameMessage) => void) | null = null;
  const post = (msg: PageToExtension): void => {
    win.postMessage(msg, win.location.origin);
  };

  win.addEventListener("message", (e) => {
    if (!(e instanceof MessageEvent) || e.source !== win || e.origin !== win.location.origin) return;
    const r = v.safeParse(ExtensionToPageSchema, e.data);
    if (!r.success) return;
    const msg = r.output;
    if (msg.kind === "present") {
      if (present) return;
      present = true;
      onPresent?.();
      return;
    }
    // frame-* (ADR 0057 §3) belongs to the frame adapter.
    if (msg.kind !== "unlock-result") {
      onFrameMsg?.(msg);
      return;
    }
    if (pending?.host === msg.host) {
      const { resolve } = pending;
      pending = null;
      if (msg.outcome === "unlocked") unlocked = true;
      resolve(msg.outcome);
    } else if (msg.outcome === "unlocked") {
      // An answer for an embed that's gone (relocked while the viewer was still deciding): drop it again.
      post({ source: BRIDGE_SOURCE, kind: "relock" });
    }
  });

  return {
    whenPresent(cb) {
      onPresent = cb;
      if (present) cb();
    },
    unlock(host) {
      return new Promise((resolve) => {
        pending = { host, resolve };
        post({ source: BRIDGE_SOURCE, kind: "unlock", host });
      });
    },
    relock() {
      if (!unlocked && pending === null) return;
      unlocked = false;
      pending = null;
      post({ source: BRIDGE_SOURCE, kind: "relock" });
    },
    toFrame: post,
    onFrame(cb) {
      onFrameMsg = cb;
      return () => {
        if (onFrameMsg === cb) onFrameMsg = null;
      };
    },
  };
}
