import type { PlayerAdapter, PlayerEvent, PlayerState } from "./adapter";
import type { YtEvent, YtNamespace } from "./youtube-types";

/** Player state events this soon after our own command are its echo, not the user (research §1.5). */
export const ECHO_WINDOW_MS = 1000;
/** A duration further than this from the content's reads as an ad (research §1.4). */
const AD_DURATION_TOLERANCE_S = 1;

const STATES: Readonly<Record<number, PlayerState>> = {
  [-1]: "unstarted",
  0: "ended",
  1: "playing",
  2: "paused",
  3: "buffering",
  5: "cued",
};
const ONE: readonly number[] = [1];

export interface AttachOptions {
  /** The room's video; anything else playing in the player is treated as an ad. */
  readonly videoId: string;
  /** Monotonic ms, for the echo window. */
  readonly now: () => number;
}

/**
 * Attach the official IFrame API to the iframe `tvFrame()` built (ADR 0011). Never
 * `new YT.Player(div, { videoId })`: that would let the API choose src, sandbox and allow.
 */
export function attachYouTube(yt: YtNamespace, iframe: HTMLIFrameElement, opts: AttachOptions): PlayerAdapter {
  const listeners = new Set<(e: PlayerEvent) => void>();
  let isReady = false;
  let destroyed = false;
  /** Content duration, learned while the room's video (not an ad) is showing. */
  let contentDuration = 0;
  /** What our last command should have produced; null until we've issued one (autoplay at load is not an intent). */
  let expected: "playing" | "paused" | null = null;
  let lastCommandAt = Number.NEGATIVE_INFINITY;

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
        learnDuration();
        emit({ type: "ready" });
      },
      onStateChange: (e: YtEvent) => {
        if (destroyed) return;
        const s = inAd() ? "ad" : mapState(e.data);
        emit({ type: "state", state: s });
        if (s !== "playing" && s !== "paused") return;
        if (expected === null || s === expected || opts.now() - lastCommandAt < ECHO_WINDOW_MS) return;
        expected = s;
        emit({ type: "intent", playing: s === "playing", position: time() });
      },
      onError: (e: YtEvent) => {
        emit({ type: "error", code: typeof e.data === "number" && Number.isInteger(e.data) ? e.data : -1 });
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
  /** The playing video's id, or null if the player doesn't say. */
  function playingId(): string | null {
    const vd = player.getVideoData();
    if (typeof vd !== "object" || vd === null || !("video_id" in vd)) return null;
    return typeof vd.video_id === "string" && vd.video_id !== "" ? vd.video_id : null;
  }
  function learnDuration(): void {
    if (contentDuration > 0 || playingId() !== opts.videoId) return;
    contentDuration = duration();
  }
  function inAd(): boolean {
    const id = playingId();
    if (id !== null && id !== opts.videoId) return true;
    learnDuration();
    const d = duration();
    return contentDuration > 0 && d > 0 && Math.abs(d - contentDuration) > AD_DURATION_TOLERANCE_S;
  }

  return {
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

function mapState(n: unknown): PlayerState {
  return (typeof n === "number" ? STATES[n] : undefined) ?? "unstarted";
}
