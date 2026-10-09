// Minimal typed view of the Twitch Embed JS SDK's `Twitch.Player` (research M2 §1.1). Only what we
// call. Read-outs are `unknown`: the SDK is third-party code, so the adapter guards them.

import type { TwitchOptions } from "../tv";

/** Event names as the served v1.js spells them (`Twitch.Player.READY` = "ready", …). */
export type TwitchEventName = "ready" | "play" | "playing" | "pause" | "ended" | "online" | "offline" | "playbackBlocked" | "seek" | "error";

export interface TwitchPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setMuted(muted: boolean): void;
  /** 0–1. */
  setVolume(volume: number): void;
  /** The SDK's cached value from the iframe's last state push; no extrapolation. */
  getCurrentTime(): unknown;
  getDuration(): unknown;
  isPaused(): unknown;
  getEnded(): unknown;
  /** Undocumented, in the served code: `{ playback: "Idle" | "Ready" | "Buffering" | "Playing" | "Ended", … }`. */
  getPlayerState?: () => unknown;
  /** The SDK's cached list: `[{ name: "720p60", group: "720p60", … }]` (research R-M7b). */
  getQualities?: () => unknown;
  /** The group playing now. */
  getQuality?: () => unknown;
  /** Takes a `group`. No change event is documented. */
  setQuality?: (group: string) => void;
  addEventListener(name: TwitchEventName, cb: (params?: unknown) => void): void;
  removeEventListener(name: TwitchEventName, cb: (params?: unknown) => void): void;
  destroy?: () => void;
}

/**
 * `window.Twitch`. The SDK builds its own iframe inside `el` from `options` (ADR 0014 §5), so the
 * constructor only ever gets the frozen options `tvFrame()` derived. What it returns is guarded.
 */
export interface TwitchNamespace {
  readonly Player: new (el: HTMLElement, options: TwitchOptions) => unknown;
}

const METHODS = ["play", "pause", "seek", "setMuted", "setVolume", "getCurrentTime", "getDuration", "isPaused", "getEnded", "addEventListener", "removeEventListener"] as const;

/** Boundary guard for the `Twitch` global. */
export function asTwitchNamespace(x: unknown): TwitchNamespace | null {
  if (typeof x !== "object" || x === null || !("Player" in x) || typeof x.Player !== "function") return null;
  // Checked above: Player is a constructor; what it builds is checked by asTwitchPlayer().
  return x as TwitchNamespace;
}

/** Boundary guard for a constructed player: every method we call must be a function. */
export function asTwitchPlayer(x: unknown): TwitchPlayer | null {
  if (typeof x !== "object" || x === null) return null;
  for (const m of METHODS) if (!(m in x) || typeof (x as Record<string, unknown>)[m] !== "function") return null;
  for (const m of ["getPlayerState", "destroy", "getQualities", "getQuality", "setQuality"] as const) if (m in x && typeof (x as Record<string, unknown>)[m] !== "function") return null;
  // Checked above: every method we call exists.
  return x as TwitchPlayer;
}
