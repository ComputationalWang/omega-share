import { playbackCaps, type Embed } from "@omega/shared";
import type { PlayerAdapter, PlayerErrorReason, PlayerEvent, PlayerState } from "./adapter";
import type { AdapterFactory } from "./registry";
import { loadYouTubeApi } from "./youtube-loader";
import type { YtEvent, YtNamespace } from "./youtube-types";

/** Player state events this soon after our own command are its echo, not the user (research §1.5). */
export const ECHO_WINDOW_MS = 1000;
/** A duration further than this from the content's reads as an ad (research §1.4). */
const AD_DURATION_TOLERANCE_S = 1;
/**
 * A duration-only "ad" that lasts this long means we learned the wrong content
 * duration (a pre-roll that reports the content id): re-learn it.
 */
export const AD_RELEARN_MS = 120_000;

const STATES: Readonly<Record<number, PlayerState>> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
  5: "cued",
};
const ONE: readonly number[] = [1];

export type YouTubeEmbed = Extract<Embed, { provider: "youtube" }>;

export interface AttachOptions {
  /** The room's video; anything else playing in the player is treated as an ad. */
  readonly embed: YouTubeEmbed;
  /** Monotonic ms, for the echo window. */
  readonly now: () => number;
}

/**
 * Attach the official IFrame API to the iframe `tvFrame()` built (ADR 0011). Never
 * `new YT.Player(div, { videoId })`: that would let the API choose src, sandbox and allow.
 */
export function attachYouTube(yt: YtNamespace, iframe: HTMLIFrameElement, opts: AttachOptions): PlayerAdapter {
  const videoId = opts.embed.videoId;
  const listeners = new Set<(e: PlayerEvent) => void>();
  let isReady = false;
  let destroyed = false;
  /** Content duration, learned while the room's video (not an ad) is showing. */
  let contentDuration = 0;
  /** What our last command should have produced; null until we've issued one (autoplay at load is not an intent). */
  let expected: "playing" | "paused" | null = null;
  let lastCommandAt = Number.NEGATIVE_INFINITY;
  /** Last playing/paused seen, ignoring buffering; null after load, cue, end or an ad. Only a change between settled states can be the user. */
  let settled: "playing" | "paused" | null = null;
  /** The playing video id, refreshed on player events (not per poll). */
  let playingId: string | null = null;
  /** When the duration rule alone started calling this an ad; -1 = it isn't. */
  let durationAdSince = -1;

  const emit = (e: PlayerEvent) => {
    if (destroyed) return;
    for (const l of listeners) l(e);
  };
  const command = (exp: "playing" | "paused" | null) => {
    if (exp !== null) expected = exp;
    lastCommandAt = opts.now();
  };

  const player = new yt.Player(iframe, {
    events: {
      onReady: () => {
        if (destroyed) return;
        isReady = true;
        readId();
        learnDuration();
        emit({ type: "ready" });
      },
      onStateChange: (e: YtEvent) => {
        if (destroyed) return;
        readId();
        const raw = mapState(e.data);
        if (raw === "playing" || raw === "paused") learnDuration();
        const s = inAd() ? "ad" : raw;
        emit({ type: "state", state: s });
        if (s === "buffering") return;
        if (s !== "playing" && s !== "paused") {
          settled = null;
          return;
        }
        const from = settled;
        settled = s;
        if (from === null || from === s || expected === null || s === expected) return;
        if (opts.now() - lastCommandAt < ECHO_WINDOW_MS) return;
        expected = s;
        emit({ type: "intent", playing: s === "playing", position: time() });
      },
      onError: (e: YtEvent) => {
        const code = typeof e.data === "number" && Number.isInteger(e.data) ? e.data : -1;
        emit({ type: "error", reason: errorReason(code), code: String(code) });
      },
      onAutoplayBlocked: () => {
        if (destroyed) return;
        player.mute();
        player.playVideo();
        command("playing");
        emit({ type: "autoplay-blocked" });
      },
    },
  });

  function time(): number {
    const t = player.getCurrentTime();
    return typeof t === "number" && Number.isFinite(t) && t >= 0 ? t : 0;
  }
  function duration(): number {
    const d = player.getDuration();
    return typeof d === "number" && Number.isFinite(d) && d > 0 ? d : 0;
  }
  function readId(): void {
    const vd = player.getVideoData();
    const id = typeof vd === "object" && vd !== null && "video_id" in vd ? vd.video_id : null;
    playingId = typeof id === "string" && id !== "" ? id : null;
  }
  function learnDuration(): void {
    if (contentDuration > 0 || playingId !== videoId) return;
    contentDuration = duration();
  }
  function inAd(): boolean {
    if (playingId !== null && playingId !== videoId) return true;
    const d = duration();
    if (contentDuration <= 0 || d <= 0 || Math.abs(d - contentDuration) <= AD_DURATION_TOLERANCE_S) {
      durationAdSince = -1;
      return false;
    }
    const now = opts.now();
    if (durationAdSince < 0) durationAdSince = now;
    if (now - durationAdSince <= AD_RELEARN_MS) return true;
    contentDuration = d;
    durationAdSince = -1;
    return false;
  }

  return {
    caps: playbackCaps(opts.embed),
    ready: () => isReady && !destroyed,
    play() {
      if (!isReady || destroyed) return;
      command("playing");
      player.playVideo();
    },
    pause() {
      if (!isReady || destroyed) return;
      command("paused");
      player.pauseVideo();
    },
    seek(seconds) {
      if (!isReady || destroyed) return;
      command(null);
      player.seekTo(seconds, true);
    },
    setRate(rate) {
      if (!isReady || destroyed) return;
      player.setPlaybackRate(rate);
    },
    unmute() {
      if (!isReady || destroyed) return;
      player.unMute();
    },
    setVolume(volume) {
      if (!isReady || destroyed) return;
      player.setVolume(volume);
    },
    time,
    duration: () => contentDuration,
    state() {
      if (!isReady) return "unstarted";
      return inAd() ? "ad" : mapState(player.getPlayerState());
    },
    rates() {
      const r = player.getAvailablePlaybackRates();
      if (!Array.isArray(r) || r.length === 0) return ONE;
      for (const x of r) if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return ONE;
      return r as readonly number[];
    },
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      isReady = false;
      listeners.clear();
      player.destroy();
    },
  };
}

/** 101/150: the owner doesn't allow embedding; 100: removed or private (research M1b §1.1). */
function errorReason(code: number): PlayerErrorReason {
  if (code === 101 || code === 150) return "refused";
  return code === 100 ? "not-found" : "other";
}

/** The registry's YouTube factory: loads the IFrame API only now, then attaches to the iframe `tvFrame()` built. */
export const mountYouTube: AdapterFactory<YouTubeEmbed> = async (c) => {
  const iframe = c.target.iframe;
  if (c.frame.kind !== "iframe" || iframe === null) return { ok: false, reason: "invalid" };
  const r = await loadYouTubeApi();
  if (!r.ok) return { ok: false, reason: r.reason === "timeout" ? "timeout" : "load-failed" };
  return { ok: true, player: attachYouTube(r.yt, iframe, { embed: c.embed, now: c.now }) };
};

function mapState(n: unknown): PlayerState {
  return (typeof n === "number" ? STATES[n] : undefined) ?? "unstarted";
}
