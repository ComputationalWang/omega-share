import { playbackCaps, type Embed } from "@omega/shared";
import { twitchIframeMatches, type TvTwitch } from "../tv";
import type { PlayerAdapter, PlayerErrorReason, PlayerEvent, PlayerState } from "./adapter";
import type { AdapterFactory } from "./registry";
import { NO_QUALITIES, QUALITY_ECHO_MS, parseQualities, sameQualities, type QualityOption } from "./quality";
import { loadTwitchApi, type TwitchLoad } from "./twitch-loader";

export { QUALITY_ECHO_MS };
import { asTwitchPlayer, type TwitchEventName, type TwitchNamespace, type TwitchPlayer } from "./twitch-types";

/** Play/pause events this soon after our own command are its echo, not the user (as for YouTube). */
export const ECHO_WINDOW_MS = 1000;
/**
 * Live: our play reloads at the live edge, where Twitch can run a mid-roll slate that the SDK reports as
 * pause/play with no ad signal (OME-497). A player pause/play this soon after our play is the provider's;
 * the sync loop re-plays a paused player while the room plays.
 */
export const LIVE_RESUME_MS = 5000;
/** A seek event this soon after our own seek is its echo; Twitch VODs are HLS, so a seek can take seconds. */
export const SEEK_ECHO_MS = 5000;
/** The SDK has no ad signal: a VOD that says Playing while its clock hasn't moved for this long is in an ad (research M2 §1.4). */
export const AD_FROZEN_MS = 2000;
/** A wrong `parent` shows an in-player error and sends nothing (research M2 §2.1), so a player that never gets ready times out. */
export const READY_TIMEOUT_MS = 10_000;
/** Extrapolation past the last pushed time is capped, as YouTube's widget does (research M2 §6.2). */
const MAX_EXTRAPOLATE_S = 1;
/**
 * The iframe's periodic UPDATE_STATE (~1.06 s) carries a currentTime this old while playing (196–211 ms measured,
 * ADR 0027). Pushes right after play/seek are fresh; the previous reading carried forward catches those.
 */
export const PUSH_LAG_MS = 200;
const PUSH_LAG_S = PUSH_LAG_MS / 1000;
/** A playing reading this close above the carried previous one is the same timeline (a fresh push), not a jump. */
const SAME_TIMELINE_S = 2 * PUSH_LAG_S;

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
  /** Subscribe to the page's postMessages by `source`; returns unsubscribe. The SDK updates its cache from them. */
  readonly messages: (fn: (source: unknown) => void) => () => void;
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
  // The cache is read as each of our iframe's messages arrives, so `baseAt` is the push's arrival.
  let cached = Number.NaN;
  let base = 0;
  let baseAt = o.now();
  let playback = "";
  /** The previous playing reading (lag added) and when (ms); -Infinity = none since the clock last stopped or jumped. */
  let prevRead = 0;
  let prevReadAt = Number.NEGATIVE_INFINITY;
  /** When we last asked for a quality; its pause/play and seek are the echo. */
  let qualitySetAt = Number.NEGATIVE_INFINITY;
  let qualities: readonly QualityOption[] = NO_QUALITIES;
  let quality: string | null = null;
  const frameWindow: unknown = iframeWindow(container);

  const emit = (e: PlayerEvent) => {
    if (destroyed) return;
    for (const l of listeners) l(e);
  };

  const moved = (at: number, now: number): void => {
    base = at;
    baseAt = now;
    prevRead = at;
    prevReadAt = now;
  };
  /** Read the SDK's cache. No allocation: runs on every sync tick and our iframe's messages. */
  const sample = (): void => {
    const now = o.now();
    const pb = readPlayback();
    if (pb !== playback) {
      playback = pb;
      // The clock starts or stops here, from where it is.
      moved(base, now);
    }
    const t = player.getCurrentTime();
    if (typeof t === "number" && Number.isFinite(t) && t >= 0 && t !== cached) {
      cached = t;
      if (live || playback !== "Playing") {
        base = t;
        prevReadAt = Number.NEGATIVE_INFINITY;
      } else {
        const read = t + PUSH_LAG_S;
        const carried = prevRead + (now - prevReadAt) / 1000;
        base = carried < read && read - carried <= SAME_TIMELINE_S ? carried : read;
        prevRead = read;
        prevReadAt = now;
      }
      baseAt = now;
    }
  };
  const offMessages = o.messages((source) => {
    if (frameWindow !== null && source === frameWindow && isReady && !destroyed) sample();
  });
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

  /** Re-read the SDK's cached list and quality (no change event exists); a quality event if either changed. */
  const readQualities = (): void => {
    const next = parseQualities(player.getQualities?.(), "group", "name");
    const q = player.getQuality?.();
    const cur = typeof q === "string" && next.some((o) => o.id === q) ? q : null;
    if (sameQualities(next, qualities) && cur === quality) return;
    qualities = next;
    quality = cur;
    emit({ type: "quality" });
  };
  const inQualityEcho = (): boolean => o.now() - qualitySetAt < QUALITY_ECHO_MS;

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
    const since = o.now() - lastCommandAt;
    if (since < ECHO_WINDOW_MS || (live && expected === "playing" && since < LIVE_RESUME_MS)) return;
    if (inQualityEcho()) {
      // The switch's own pause/play: the sync loop puts this player back where the room is.
      expected = s;
      return;
    }
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
    moved(position, now);
    if (expected === null || settled === null || inQualityEcho()) return;
    emit({ type: "intent", playing: settled === "playing", position });
  };

  const handlers: Readonly<Record<TwitchEventName, (params?: unknown) => void>> = {
    ready: () => {
      if (destroyed || isReady) return;
      isReady = true;
      o.clearTimeout(readyTimer);
      emit({ type: "ready" });
      readQualities();
    },
    play: () => {
      settle("playing");
    },
    playing: () => {
      settle("playing");
      if (isReady) readQualities();
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
      moved(seconds, seekSentAt);
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
    quality: {
      options: () => (isReady ? qualities : NO_QUALITIES),
      current: () => (isReady ? quality : null),
      set(id) {
        if (!usable() || !qualities.some((q) => q.id === id) || player.setQuality === undefined) return;
        qualitySetAt = o.now();
        player.setQuality(id);
        // getQuality() is the iframe's last push, still the old one: take ours until the next re-read.
        quality = id;
        emit({ type: "quality" });
      },
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      isReady = false;
      o.clearTimeout(readyTimer);
      offMessages();
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

/** The window our player's messages come from: the SDK's iframe, rendered synchronously by the Player constructor. */
function iframeWindow(container: HTMLElement): unknown {
  const f = container.children[0];
  return f !== undefined && "contentWindow" in f ? f.contentWindow : null;
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
      messages: (fn) => {
        const h = (e: MessageEvent) => {
          fn(e.source);
        };
        addEventListener("message", h);
        return () => {
          removeEventListener("message", h);
        };
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
