import { DEFAULT_CONTROL_POLICY, playbackCaps, type ClientMessage, type ControlPolicy, type PlaybackState, type Provider } from "@omega/shared";
import { playerIntent, seekIntent, togglePlayIntent, type PlaybackTarget } from "../intents";
import type { PlayerAdapter, PlayerError, PlayerEvent } from "../player/adapter";
import { SYNC_INTERVAL_MS, createSyncLoop, expectedPosition, type SyncLoop } from "../sync";
import { NOT_CATCHING, stepCatchup, type Catchup } from "./catchup";

/** Everything the playback chrome renders. A new object only when something in it changed. */
export interface PlaybackView {
  /** A player for the room's video is attached and ready. */
  readonly hasVideo: boolean;
  /** The room has a video with playback and I may control it, so the shared transport can send. */
  readonly canControl: boolean;
  /** The room's (shared) state, not this player's. */
  readonly playing: boolean;
  /** The room's position now, whole seconds (so the view changes once a second, not every tick). */
  readonly position: number;
  /** Seconds; 0 = unknown (the seek bar stays disabled). */
  readonly duration: number;
  /** This user only (ADR 0002): 0–100. Never on the wire. */
  readonly volume: number;
  readonly muted: boolean;
  /** The browser blocked sound; show Unmute outside the player. */
  readonly needsUnmute: boolean;
  /** This client's player is buffering or in an ad while the room plays. */
  readonly catching: boolean;
  /** The provider refused the video on this client, or (offline) the channel is off air. The transport is frozen; the site shows why. */
  readonly error: PlayerError | null;
  /** The room's embed provider, for the TV's nameplate; null without an embed. */
  readonly provider: Provider | null;
  /** A live stream: no position to share, so no scrubber; only pause / play-from-live (ADR 0014 §3). */
  readonly live: boolean;
  /** Drift is fixed by small jumps (the seek-only hint): the provider can't set the rate, or the sync loop fell back (rejected Vimeo rate probe). */
  readonly seekOnly: boolean;
  /** Who controls playback (ADR 0030): under `owner` the shelf chip reads Host instead of Everyone. */
  readonly policy: ControlPolicy;
  /** Only the owner controls playback and I'm not the owner: the shared keys sink into the shelf (set j). */
  readonly held: boolean;
}

/** The room's control policy as it applies to me (state.ts `controlPolicy`, `controlHeld`). */
export interface ControlAccess {
  readonly policy: ControlPolicy;
  readonly held: boolean;
}

/** What the controller needs of the clock-sync module (`ClockSync` fits). */
export interface ControllerClock {
  readonly ready: boolean;
  serverNow(): number;
  /** Called every tick; detects OS sleep. */
  tick(): void;
}

export interface PlaybackControllerOptions<Timer> {
  /** The room connection: the shared transport, in-player clicks and my catching-up `status`. */
  readonly send: (msg: ClientMessage) => boolean;
  readonly clock: ControllerClock;
  /** Monotonic client ms. */
  readonly now: () => number;
  readonly setInterval: (fn: () => void, ms: number) => Timer;
  readonly clearInterval: (t: Timer) => void;
  readonly onView?: (v: PlaybackView) => void;
}

export interface PlaybackController {
  /** The room's embed and playback, after every state change. A new embed url drops the player; a new playback object hard-seeks. */
  setRoom(t: PlaybackTarget): void;
  /** The player built for the embed with canonical `embedUrl`. Refused (and destroyed) if the room has moved on. */
  attach(player: PlayerAdapter, embedUrl: string): void;
  /** Who controls playback, after every state change. Held: no shared intent goes out, from the transport or the player. */
  setControl(a: ControlAccess): void;
  /** Shared: play/pause for everyone. False if nothing was sent. */
  togglePlay(): boolean;
  /** Shared: seek for everyone, seconds. */
  seek(position: number): boolean;
  /** Personal. */
  setVolume(volume: number): void;
  toggleMute(): void;
  /** After a blocked autoplay; must run in a user gesture. */
  unmute(): void;
  /** A fresh join (snapshot): the server has forgotten my `status`, so it goes out again if I'm catching up. */
  joined(): void;
  tick(): void;
  start(): void;
  stop(): void;
  destroy(): void;
  view(): PlaybackView;
}

const clampVolume = (v: number): number => (Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : 100);

/**
 * The room's playback glue: connection → clock → sync loop → player. One 4 Hz timer
 * ticks the clock, the sync loop and the catching-up state. Volume only ever reaches
 * the local player; `send` is used for shared intents alone.
 */
export function createPlaybackController<Timer>(o: PlaybackControllerOptions<Timer>): PlaybackController {
  let target: PlaybackTarget = { embed: null, playback: null };
  let embedUrl: string | null = null;
  let pb: PlaybackState | null = null;
  let player: PlayerAdapter | null = null;
  let loop: SyncLoop | null = null;
  let offPlayer: (() => void) | null = null;
  let volume = 100;
  let muted = false;
  let needsUnmute = false;
  let catchup: Catchup = NOT_CATCHING;
  /** The `catching` the server last got from us (ADR 0019); a fresh join starts at false. */
  let sentCatching = false;
  let error: PlayerError | null = null;
  let provider: Provider | null = null;
  let live = false;
  /** From the embed's static caps (Twitch VOD); the loop can also fall back at runtime (a rejected Vimeo rate probe). */
  let capsSeekOnly = false;
  let seekOnly = false;
  let policy: ControlPolicy = DEFAULT_CONTROL_POLICY;
  let held = false;
  let timer: Timer | null = null;
  let current: PlaybackView = {
    hasVideo: false,
    canControl: false,
    playing: false,
    position: 0,
    duration: 0,
    volume,
    muted,
    needsUnmute,
    catching: false,
    error,
    provider,
    live,
    seekOnly,
    policy,
    held,
  };

  const detach = (): void => {
    offPlayer?.();
    offPlayer = null;
    loop?.destroy();
    loop = null;
    player?.destroy();
    player = null;
    catchup = NOT_CATCHING;
    needsUnmute = false;
    error = null;
  };

  const applyVolume = (): void => {
    if (player === null) return;
    player.setVolume(muted ? 0 : volume);
  };

  const startLoop = (p: PlayerAdapter): void => {
    loop = createSyncLoop({ player: p, clock: o.clock, now: o.now, setInterval: o.setInterval, clearInterval: o.clearInterval });
    loop.setPlayback(pb);
  };

  const refresh = (): PlaybackView => {
    const refused = error !== null;
    const duration = refused || live ? 0 : (player?.duration() ?? 0);
    let position = pb === null || refused || live ? 0 : o.clock.ready ? expectedPosition(pb, o.clock.serverNow()) : pb.position;
    if (duration > 0 && position > duration) position = duration;
    position = Math.floor(position);
    const c = current;
    const hasVideo = !refused && player?.ready() === true;
    const playing = !refused && (pb?.playing ?? false);
    // Pausing a playing room needs the server clock for the position; playing a paused one doesn't. Live has no position.
    const canControl = !refused && !held && pb !== null && embedUrl !== null && (!pb.playing || live || o.clock.ready);
    seekOnly = capsSeekOnly || loop?.mode === "seek-only";
    if (
      c.hasVideo === hasVideo &&
      c.canControl === canControl &&
      c.playing === playing &&
      c.position === position &&
      c.duration === duration &&
      c.volume === volume &&
      c.muted === muted &&
      c.needsUnmute === needsUnmute &&
      c.catching === catchup.catching &&
      c.error === error &&
      c.provider === provider &&
      c.live === live &&
      c.seekOnly === seekOnly &&
      c.policy === policy &&
      c.held === held
    ) {
      return c;
    }
    current = { hasVideo, canControl, playing, position, duration, volume, muted, needsUnmute, catching: catchup.catching, error, provider, live, seekOnly, policy, held };
    o.onView?.(current);
    return current;
  };

  const onPlayer = (e: PlayerEvent): void => {
    switch (e.type) {
      case "ready":
        applyVolume();
        break;
      case "autoplay-blocked":
        needsUnmute = true;
        break;
      case "intent": {
        // Held: the sync loop puts the player back where the room is.
        const msg = error === null && !held ? playerIntent(target, e.playing, e.position) : null;
        if (msg !== null) o.send(msg);
        break;
      }
      case "error":
        // Keep the player (its own "Video unavailable" stays visible) but stop driving it.
        error = { reason: e.reason, code: e.code };
        loop?.destroy();
        loop = null;
        catchup = NOT_CATCHING;
        break;
      case "state":
        // Offline clears itself: the adapter reports a state again once the channel is back on air.
        if (error?.reason !== "offline" || player === null) return;
        error = null;
        startLoop(player);
        break;
    }
    refresh();
  };

  const send = (msg: ClientMessage | null): boolean => msg !== null && !held && o.send(msg);

  function tick(): void {
    o.clock.tick();
    loop?.tick();
    catchup = player === null || error !== null ? NOT_CATCHING : stepCatchup(catchup, { now: o.now(), playerState: player.state(), roomPlaying: pb?.playing ?? false });
    // Already held for CATCHUP_SHOW_MS by stepCatchup, so a changed value goes straight out. A failed send retries next tick.
    if (catchup.catching !== sentCatching && o.send({ type: "status", catching: catchup.catching })) sentCatching = catchup.catching;
    refresh();
  }

  return {
    setRoom(t) {
      target = t;
      const url = t.embed?.url ?? null;
      if (url !== embedUrl) {
        detach();
        embedUrl = url;
        const caps = t.embed === null ? null : playbackCaps(t.embed);
        provider = t.embed?.provider ?? null;
        live = caps?.live === true;
        capsSeekOnly = caps !== null && !caps.live && caps.rate === "no";
      }
      const next = t.playback ?? null;
      if (next !== pb) {
        pb = next;
        // Applied at once once the loop ticks (OME-452).
        loop?.setPlayback(pb);
      }
      refresh();
    },
    setControl(a) {
      policy = a.policy;
      held = a.held;
      refresh();
    },
    attach(p, url) {
      if (url !== embedUrl) {
        p.destroy();
        return;
      }
      detach();
      player = p;
      startLoop(p);
      offPlayer = p.onEvent(onPlayer);
      if (p.ready()) applyVolume();
      refresh();
    },
    togglePlay() {
      if (error !== null || pb === null) return false;
      // Live: pause / play-from-live only; the server ignores the position (messages.ts `control`).
      if (live) return send(playerIntent(target, !pb.playing, 0));
      if (pb.playing && !o.clock.ready) return false;
      const msg = togglePlayIntent(target, pb.playing ? o.clock.serverNow() : pb.at);
      // A room left "playing" after the video ended would otherwise pause past the end.
      const duration = player?.duration() ?? 0;
      return send(msg !== null && duration > 0 && msg.position > duration ? { ...msg, position: duration } : msg);
    },
    seek(position) {
      if (error !== null || live) return false;
      return send(seekIntent(target, position));
    },
    setVolume(v) {
      volume = clampVolume(v);
      muted = false;
      // A volume change is a user gesture: lift a blocked autoplay's mute too.
      if (needsUnmute) {
        needsUnmute = false;
        player?.unmute();
      }
      applyVolume();
      refresh();
    },
    toggleMute() {
      if (needsUnmute) {
        this.unmute();
        return;
      }
      muted = !muted;
      if (!muted) player?.unmute();
      applyVolume();
      refresh();
    },
    unmute() {
      needsUnmute = false;
      muted = false;
      player?.unmute();
      applyVolume();
      refresh();
    },
    tick,
    joined() {
      sentCatching = false;
    },
    start() {
      timer ??= o.setInterval(tick, SYNC_INTERVAL_MS);
    },
    stop() {
      if (timer !== null) o.clearInterval(timer);
      timer = null;
    },
    destroy() {
      this.stop();
      detach();
    },
    view: refresh,
  };
}
