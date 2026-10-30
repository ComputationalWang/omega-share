import type { ExtensionBridge } from "../extension-bridge";
import type { MountResult } from "./registry";

export const ATTACH_TIMEOUT_MS = 0;

export interface FrameMountOptions<Timer> {
  readonly host: string;
  readonly bridge: Pick<ExtensionBridge, "toFrame" | "onFrame">;
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
  readonly onSync: (attached: boolean) => void;
}

export function mountFrame<Timer>(_o: FrameMountOptions<Timer>): Promise<MountResult> {
  return Promise.resolve({ ok: false, reason: "unsupported" });
}
