import { playbackCaps, type Embed } from "@omega/shared";
import { twitchIframeMatches, type TvTwitch } from "../tv";
import type { PlayerAdapter, PlayerErrorReason, PlayerEvent, PlayerState } from "./adapter";
import type { AdapterFactory } from "./registry";
import { loadTwitchApi, type TwitchLoad } from "./twitch-loader";
import { asTwitchPlayer, type TwitchEventName, type TwitchNamespace, type TwitchPlayer } from "./twitch-types";

/** Play/pause events this soon after our own command are its echo, not the user (as for YouTube). */
export const ECHO_WINDOW_MS = 1000;
/** A seek event this soon after our own seek is its echo; Twitch VODs are HLS, so a seek can take seconds. */
export const SEEK_ECHO_MS = 5000;
/** The SDK has no ad signal: a VOD that says Playing while its clock hasn't moved for this long is in an ad (research M2 §1.4). */
export const AD_FROZEN_MS = 2000;
/** A wrong `parent` shows an in-player error and sends nothing (research M2 §2.1), so a player that never gets ready times out. */
export const READY_TIMEOUT_MS = 10_000;
/** Extrapolation past the last pushed time is capped, as YouTube's widget does (research M2 §6.2). */
const MAX_EXTRAPOLATE_S = 1;

const ONE: readonly number[] = [1];
const EVENTS: readonly TwitchEventName[] = ["ready", "play", "playing", "pause", "ended", "online", "offline", "playbackBlocked", "seek", "error"];

export type TwitchEmbed = Extract<Embed, { provider: "twitch" }>;

export interface TwitchAttachOptions<Timer> {
  readonly embed: TwitchEmbed;
  /** `tvFrame(embed)`: the frozen options the SDK builds its iframe from. */
  readonly frame: TvTwitch;
  /** Monotonic ms. */
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
}

/**
 * Render the official Twitch player into `container` (ADR 0014 §5) and wrap it as a PlayerAdapter.
 * VODs: play, pause and seek; no rate (the loop runs seek-only). Live: play and pause only; the SDK
 * resumes at the live edge. Null if the SDK built something that isn't a player.
 */
export function attachTwitch<Timer>(tw: TwitchNamespace, container: HTMLElement, o: TwitchAttachOptions<Timer>): PlayerAdapter | null {
  const built = asTwitchPlayer(new tw.Player(container, o.frame.options));
  if (built === null) return null;
  const player: TwitchPlayer = built;
  const live = o.embed.kind === "live";
  const listeners = new Set<(e: PlayerEvent) => void>();
  let isReady = false;
  let destroyed = false;
  let offline = false;
  /** What our last play/pause should have produced; null until we've issued one (autoplay at load is not an intent). */
  let expected: "playing" | "paused" | null = null;
  let lastCommandAt = Number.NEGATIVE_INFINITY;
  /** Last playing/paused from the SDK's events; null after load or end. Only a change between them can be the user. */
  let settled: "playing" | "paused" | null = null;
  /** When our last seek was sent; its seek event is the echo. -Infinity = none pending. */
  let seekSentAt = Number.NEGATIVE_INFINITY;
  // Media clock (VOD): the SDK's cached currentTime only changes on the iframe's pushes, so keep
  // the last value read, and when our view of it (`base`) last moved, and extrapolate from there.
  let cached = Number.NaN;
  let base = 0;
  let baseAt = o.now();
  let playback = "";

  const emit = (e: PlayerEvent) => {
    if (destroyed) return;
    for (const l of listeners) l(e);
  };

  /** Read the SDK's cache. No allocation: runs on every sync tick. */
  const sample = (): void => {
    const now = o.now();
    const t = player.getCurrentTime();
    if (typeof t === "number" && Number.isFinite(t) && t >= 0 && t !== cached) {
      cached = t;
      base = t;
      baseAt = now;
    }
    const pb = readPlayback();
    if (pb !== playback) {
      playback = pb;
      baseAt = now;
    }
  };
  function readPlayback(): string {
    const s = player.getPlayerState?.();
    if (typeof s === "object" && s !== null && "playback" in s && typeof s.playback === "string") return s.playback;
    if (player.getEnded() === true) return "Ended";
    return player.isPaused() === true ? "Idle" : "Playing";
  }
  const frozenFor = (): number => o.now() - baseAt;
  const inAd = (): boolean => !live && playback === "Playing" && frozenFor() > AD_FROZEN_MS;

  function state(): PlayerState {
    if (!isReady) return "unstarted";
    sample();
    switch (playback) {
      case "Playing":
        return inAd() ? "ad" : "playing";
      case "Idle":
        return "paused";
      case "Buffering":
        return "buffering";
      case "Ended":
        return "ended";
      default:
        return "cued";
    }
  }
  function time(): number {
    if (live || !isReady) return 0;
    sample();
    if (playback !== "Playing" || inAd()) return base;
    return base + Math.min(MAX_EXTRAPOLATE_S, frozenFor() / 1000);
  }

  const command = (exp: "playing" | "paused") => {
    expected = exp;
    lastCommandAt = o.now();
  };

  /** A play/pause event from the SDK: ours (echo) or the user's (intent). */
  const settle = (s: "playing" | "paused"): void => {
    if (offline) return;
    emit({ type: "state", state: state() });
    const from = settled;
    settled = s;
    if (from === null || from === s || expected === null || s === expected) return;
    if (o.now() - lastCommandAt < ECHO_WINDOW_MS) return;
    expected = s;
    emit({ type: "intent", playing: s === "playing", position: time() });
  };

  const onSeek = (params: unknown): void => {
    // Live: a resume jumps to the live edge and reports it as a seek. Not the user's.
    if (live || offline) return;
    const now = o.now();
    if (now - seekSentAt < SEEK_ECHO_MS) {
      seekSentAt = Number.NEGATIVE_INFINITY;
      return;
    }
    const at = typeof params === "object" && params !== null && "position" in params ? params.position : undefined;
    const position = typeof at === "number" && Number.isFinite(at) && at >= 0 ? at : time();
    base = position;
    baseAt = now;
    if (expected === null || settled === null) return;
    emit({ type: "intent", playing: settled === "playing", position });
  };

  const handlers: Readonly<Record<TwitchEventName, (params?: unknown) => void>> = {
    ready: () => {
      if (destroyed || isReady) return;
      isReady = true;
      o.clearTimeout(readyTimer);
      emit({ type: "ready" });
    },
    play: () => {
      settle("playing");
    },
    playing: () => {
      settle("playing");
    },
    pause: () => {
      settle("paused");
    },
    ended: () => {
      settled = null;
      if (!offline) emit({ type: "state", state: "ended" });
    },
    seek: onSeek,
    playbackBlocked: () => {
      if (destroyed) return;
      player.setMuted(true);
      player.play();
      command("playing");
      emit({ type: "autoplay-blocked" });
    },
    offline: () => {
      offline = true;
      emit({ type: "error", reason: "offline", code: "offline" });
    },
    online: () => {
      if (!offline) return;
      offline = false;
      emit({ type: "state", state: state() });
    },
    error: (params) => {
      const code = typeof params === "object" && params !== null && "code" in params ? params.code : undefined;
      const c = typeof code === "number" && Number.isFinite(code) ? String(code) : typeof code === "string" && code !== "" ? code : "unknown";
      emit({ type: "error", reason: errorReason(c), code: c });
    },
  };
  const readyTimer = o.setTimeout(() => {
    if (!isReady && !destroyed) emit({ type: "error", reason: "timeout", code: "ready-timeout" });
  }, READY_TIMEOUT_MS);
  for (const name of EVENTS) player.addEventListener(name, handlers[name]);

  const usable = () => isReady && !destroyed;
  return {
    caps: playbackCaps(o.embed),
    ready: usable,
    play() {
      if (!usable()) return;
      command("playing");
      player.play();
    },
    pause() {
      if (!usable()) return;
      command("paused");
      player.pause();
    },
    seek(seconds) {
      if (!usable() || live) return;
      seekSentAt = o.now();
      base = seconds;
      baseAt = seekSentAt;
      player.seek(seconds);
    },
    setRate() {
      // Twitch has no rate setter (research M2 §1.1); caps.rate is "no", so the loop never asks.
    },
    unmute() {
      if (!usable()) return;
      player.setMuted(false);
    },
    setVolume(volume) {
      if (!usable()) return;
      player.setVolume(volume / 100);
    },
    time,
    duration() {
      if (live || !isReady) return 0;
      const d = player.getDuration();
      return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : 0;
    },
    state,
    rates: () => ONE,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      isReady = false;
      o.clearTimeout(readyTimer);
      listeners.clear();
      for (const name of EVENTS) player.removeEventListener(name, handlers[name]);
      player.destroy?.();
    },
  };
}

/** Twitch's enum (research M2 §2.1): GeoBlocked 1, UnauthorizationEntitlements 5, VodRestricted 6, ContentNotAvailable 5000. */
function errorReason(code: string): PlayerErrorReason {
  if (code === "1" || code === "5" || code === "6" || code === "vod_manifest_restricted") return "restricted";
  return code === "5000" ? "not-found" : "other";
}

/** The frame is this embed's: same content id, so the post-render check compares against the room's video. */
function frameIsEmbed(f: TvTwitch, e: TwitchEmbed): boolean {
  return e.kind === "live" ? f.options.channel === e.channel : f.options.video === `v${e.videoId}`;
}

/** The post-render check (research M2 §4.1): exactly one iframe in our container, and it is the room's player. */
function renderedOk(container: HTMLElement, frame: TvTwitch): boolean {
  if (container.children.length !== 1) return false;
  const f = container.children[0];
  return f?.tagName === "IFRAME" && twitchIframeMatches(f.getAttribute("src") ?? "", frame);
}

/** The registry's Twitch factory, over any SDK loader (tests pass a fake). */
export function createTwitchMount(load: () => Promise<TwitchLoad>): AdapterFactory<TwitchEmbed> {
  return async (c) => {
    const frame = c.frame;
    if (frame.kind !== "twitch" || c.target.iframe !== null || !frameIsEmbed(frame, c.embed)) return { ok: false, reason: "invalid" };
    const r = await load();
    if (!r.ok) return { ok: false, reason: r.reason === "timeout" ? "timeout" : "load-failed" };
    const box = c.target.container;
    const player = attachTwitch(r.twitch, box, {
      embed: c.embed,
      frame,
      now: c.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => {
        clearTimeout(t);
      },
    });
    if (player === null || !renderedOk(box, frame)) {
      player?.destroy();
      box.replaceChildren();
      return { ok: false, reason: "invalid" };
    }
    return { ok: true, player };
  };
}

/** Loads the SDK only now (the first Twitch embed on the page), renders and checks the player. */
export const mountTwitch: AdapterFactory<TwitchEmbed> = createTwitchMount(loadTwitchApi);
