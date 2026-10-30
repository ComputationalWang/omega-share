// The generic tier's player (ADR 0057 §4): the extension's script drives the `<video>` in the page's frame, and this
// adapter talks to it through the bridge. Lazily imported, only after the viewer unlocked the host and its frame loaded.
import { BRIDGE_SOURCE, type FrameCommand } from "@omega/shared/extension-bridge";
import { playbackCaps, type PlaybackCaps } from "@omega/shared";
import type { ExtensionBridge, FrameMessage } from "../extension-bridge";
import type { PlayerAdapter, PlayerEvent, PlayerState } from "./adapter";
import type { MountResult } from "./registry";

/** No frame-state by then: the host can't be synced (§4). */
export const ATTACH_TIMEOUT_MS = 5000;

const GENERIC_CAPS = playbackCaps({ provider: "generic", host: "x.invalid", url: "https://x.invalid/" });
/** `duration === Infinity` (§1): like Twitch live, play/pause only. */
const LIVE_CAPS: PlaybackCaps = Object.freeze({ seek: false, live: true, rate: "no" });
/** `HTMLMediaElement` takes any rate; these are the room's steps (and include the sync loop's bursts). */
const FRAME_RATES: readonly number[] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

type FrameStateMessage = Extract<FrameMessage, { kind: "frame-state" }>;
/** A command without its envelope; distributes over the ops. */
type Command<C = FrameCommand> = C extends FrameCommand ? Omit<C, "source" | "kind" | "host"> : never;

export interface FrameMountOptions<Timer> {
  /** The unlocked host, `GenericEmbed.host`. */
  readonly host: string;
  readonly bridge: Pick<ExtensionBridge, "toFrame" | "onFrame">;
  /** Monotonic ms. */
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
  /** The frame is (true) or is no longer (false) attached: the per-viewer label follows. */
  readonly onSync: (attached: boolean) => void;
}

/** Asks the extension to attach to `host`'s frame; resolves with a ready player on its first frame-state, else times out. Never rejects. */
export function mountFrame<Timer>(o: FrameMountOptions<Timer>): Promise<MountResult> {
  const { host, bridge } = o;
  let last: FrameStateMessage | null = null;
  /** `now()` when `last` arrived. */
  let at = 0;
  let attached = false;
  let destroyed = false;
  let off = (): void => undefined;
  const subs = new Set<(e: PlayerEvent) => void>();
  const emit = (e: PlayerEvent): void => {
    for (const cb of subs) cb(e);
  };
  /** Commands before the frame attached (or after it was lost) are dropped, like any adapter's before `ready()`. */
  const send = (c: Command): void => {
    if (attached && !destroyed) bridge.toFrame({ source: BRIDGE_SOURCE, kind: "frame-command", host, ...c });
  };

  const player: PlayerAdapter = {
    get caps() {
      return last?.live === true ? LIVE_CAPS : GENERIC_CAPS;
    },
    ready: () => attached,
    play: () => {
      send({ op: "play" });
    },
    pause: () => {
      send({ op: "pause" });
    },
    seek: (s) => {
      send({ op: "seek", value: s });
    },
    setRate: (r) => {
      send({ op: "rate", value: r });
    },
    unmute: () => {
      send({ op: "unmute" });
    },
    setVolume: (v) => {
      send({ op: "volume", value: v });
    },
    time() {
      if (last === null) return 0;
      const t = last.state === "playing" ? last.position + (last.rate * (o.now() - at)) / 1000 : last.position;
      return last.duration === null ? t : Math.min(t, last.duration);
    },
    duration: () => last?.duration ?? 0,
    state: (): PlayerState => (attached && last !== null ? last.state : "unstarted"),
    rates: () => FRAME_RATES,
    onEvent(cb) {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      attached = false;
      subs.clear();
      off();
    },
  };

  return new Promise((resolve) => {
    let mounted = false;
    const timer = o.setTimeout(() => {
      mounted = true;
      off();
      resolve({ ok: false, reason: "timeout" });
    }, ATTACH_TIMEOUT_MS);
    off = bridge.onFrame((m) => {
      if (m.host !== host || destroyed) return;
      if (m.kind === "frame-intent") {
        if (attached) emit({ type: "intent", playing: m.playing, position: m.position });
        return;
      }
      if (m.kind === "frame-lost") {
        if (!attached) return;
        attached = false;
        o.onSync(false);
        emit({ type: "state", state: "unstarted" });
        return;
      }
      const prev = attached ? (last?.state ?? null) : null;
      last = m;
      at = o.now();
      if (!attached) {
        attached = true;
        o.onSync(true);
        if (!mounted) {
          mounted = true;
          o.clearTimeout(timer);
          resolve({ ok: true, player });
          return;
        }
        // Back after frame-lost (the script re-attached to a swapped <video>).
        emit({ type: "ready" });
      }
      if (m.state !== prev) emit({ type: "state", state: m.state });
    });
    bridge.toFrame({ source: BRIDGE_SOURCE, kind: "attach", host });
  });
}
