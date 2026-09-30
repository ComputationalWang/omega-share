// Fake YouTube IFrame Player API (M1b, OME-85). Spec: docs/research/m1b-youtube-sync.md §1.1, §4.2.3.
// Served at https://www.youtube.com/iframe_api by e2e/support/network.ts as `(${installFakeYt})(window)`,
// so installFakeYt must stay self-contained: no references to anything outside its own body.

export interface FrameLike {
  tagName: string;
  src?: string;
  id?: string;
  replaceWith?: (node: FrameLike) => void;
}

export interface FakeYtHost {
  performance: { now(): number };
  setTimeout(handler: () => void, ms: number): unknown;
  document?: { getElementById(id: string): FrameLike | null; createElement(tag: "iframe"): FrameLike };
  YT?: FakeYtNamespace;
  __fakeYt?: FakeYtHooks;
  onYouTubeIframeAPIReady?: () => void;
}

export interface PlayerEvent<T = number | null> {
  target: FakePlayer;
  data: T;
}

export interface PlayerOptions {
  videoId?: string;
  events?: {
    onReady?: (e: PlayerEvent<null>) => void;
    onStateChange?: (e: PlayerEvent<number>) => void;
    onPlaybackRateChange?: (e: PlayerEvent<number>) => void;
    onError?: (e: PlayerEvent<number>) => void;
    onAutoplayBlocked?: (e: PlayerEvent<null>) => void;
  };
}

export interface VideoData {
  video_id: string;
  title: string;
  author: string;
}

export interface FakePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead?: boolean): void;
  getPlaybackRate(): number;
  setPlaybackRate(rate: number): void;
  getAvailablePlaybackRates(): number[];
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  mute(): void;
  unMute(): void;
  isMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getVideoData(): VideoData;
  getIframe(): FrameLike;
  destroy(): void;
}

export interface FakeYtNamespace {
  Player: new (el: string | FrameLike, options?: PlayerOptions) => FakePlayer;
  PlayerState: { UNSTARTED: -1; ENDED: 0; PLAYING: 1; PAUSED: 2; BUFFERING: 3; CUED: 5 };
  loaded: 1;
  ready(cb: () => void): void;
}

/** One entry per event the fake emitted, in order; `t` is performance.now() at emit time. */
export interface FakeYtEvent {
  type: "ready" | "state" | "rate" | "error" | "autoplayBlocked";
  data: number | null;
  t: number;
}

export interface FakeYtConfig {
  /** Content duration in seconds. Default 634.5 (Big Buck Bunny). */
  duration: number;
  /** Ad duration in seconds, reported by getDuration() during ad(ms). Default 15. */
  adDuration: number;
  /** Video id reported by getVideoData() during ad(ms). Default "fake-ad-0001". */
  adVideoId: string;
  availableRates: number[];
  /** false: setPlaybackRate rounds down to an available rate in the direction of 1 (documented behaviour). Default true (§1.3 spike). */
  fineRates: boolean;
  /** false: getPlaybackRate echoes the set rate but the media clock keeps playing at 1 (the §1.3 effective-rate trap). Default true. */
  applyRate: boolean;
  /** Delay before onReady, ms. Default 20. */
  readyDelayMs: number;
}

/** window.__fakeYt: fault injection and read-outs for the most recently created player. */
export interface FakeYtHooks {
  /** Emit state 3, freeze the media clock for `ms`, then return to the previous state. */
  buffering(ms: number): void;
  /** Play an ad for `ms`: emit 3 then 1; getVideoData/getDuration/getCurrentTime follow the ad; content clock frozen; then emit 3 and restore the previous state. */
  ad(ms: number): void;
  /** Block unmuted playback from now on (like a browser autoplay policy). If playing unmuted, pause (state 2). Emits onAutoplayBlocked on each blocked attempt. */
  autoplayBlocked(): void;
  /** Lift the autoplayBlocked() policy. */
  allowAutoplay(): void;
  /** Emit onError(code) and halt the media clock. */
  error(code: number): void;
  /** Delay applied to later seekTo calls: emit 3, hold at the target for `ms`, then restore the previous state. 0 = instant (default). */
  seekLatency(ms: number): void;
  /** A user click on the video: toggles play/pause, ignoring the autoplay policy (it is a user gesture). */
  clickToggle(): void;
  configure(config: Partial<FakeYtConfig>): void;
  readonly currentTime: number;
  readonly rate: number;
  readonly state: number;
  readonly events: readonly FakeYtEvent[];
  readonly player: FakePlayer | null;
}

export function installFakeYt(win: FakeYtHost): void {
  if (win.YT) return;
  const config: FakeYtConfig = {
    duration: 634.5,
    adDuration: 15,
    adVideoId: "fake-ad-0001",
    availableRates: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
    fineRates: true,
    applyRate: true,
    readyDelayMs: 20,
  };
  const log: FakeYtEvent[] = [];
  const now = () => win.performance.now();
  let blockAutoplay = false;
  let seekLatencyMs = 0;

  interface Internal {
    player: FakePlayer;
    playing(): boolean;
    muted(): boolean;
    /** Enter a temporary state-3 hold (buffering, ad, seek) and restore the pre-hold state after `ms`. */
    hold(ms: number, withAd: boolean): void;
    start(): void;
    pause(): void;
    halt(): void;
    emit(type: FakeYtEvent["type"], data: number | null): void;
  }
  let current: Internal | null = null;
  const need = (): Internal => {
    if (!current) throw new Error("__fakeYt: no YT.Player has been created yet");
    return current;
  };

  function createPlayer(el: string | FrameLike, options: PlayerOptions = {}): FakePlayer {
    const found = typeof el === "string" ? (win.document?.getElementById(el) ?? null) : el;
    if (!found) throw new Error(`YT.Player: no element ${typeof el === "string" ? el : el.tagName}`);
    let frame = found;
    if (found.tagName.toUpperCase() !== "IFRAME") {
      if (!win.document || !options.videoId) throw new Error("YT.Player: a non-iframe element needs options.videoId");
      frame = win.document.createElement("iframe");
      frame.src = `https://www.youtube.com/embed/${options.videoId}?enablejsapi=1`;
      if (found.id) frame.id = found.id;
      found.replaceWith?.(frame);
    }
    const videoId = /\/embed\/([^/?#]+)/.exec(frame.src ?? "")?.[1] ?? options.videoId ?? "";
    const handlers = options.events ?? {};

    let state = -1;
    let rate = 1;
    let muted = false;
    let volume = 100;
    let destroyed = false;
    // Media clock: while running, time = base + elapsed wall seconds * effective rate.
    let base = 0;
    let since = 0;
    let running = false;
    let endGen = 0;
    let holdGen = 0;
    let resumeTo: number | null = null;
    let adSince: number | null = null;

    const effRate = () => (config.applyRate ? rate : 1);
    const contentTime = () => (running ? Math.min(config.duration, base + ((now() - since) / 1000) * effRate()) : base);
    const freeze = () => {
      base = contentTime();
      running = false;
      endGen += 1;
    };
    const run = () => {
      since = now();
      running = true;
      const g = (endGen += 1);
      const ms = (Math.max(0, config.duration - base) / effRate()) * 1000;
      win.setTimeout(() => {
        if (g !== endGen || destroyed) return;
        base = config.duration;
        running = false;
        setState(0);
      }, ms);
    };
    const emit = (type: FakeYtEvent["type"], data: number | null) => {
      log.push({ type, data, t: now() });
      const e = { target: player, data };
      switch (type) {
        case "ready": handlers.onReady?.({ target: player, data: null }); break;
        case "state": handlers.onStateChange?.({ ...e, data: data ?? -1 }); break;
        case "rate": handlers.onPlaybackRateChange?.({ ...e, data: data ?? 1 }); break;
        case "error": handlers.onError?.({ ...e, data: data ?? 0 }); break;
        case "autoplayBlocked": handlers.onAutoplayBlocked?.({ target: player, data: null }); break;
      }
    };
    const setState = (s: number) => {
      state = s;
      emit("state", s);
    };
    const cancelHold = () => {
      holdGen += 1;
      resumeTo = null;
      adSince = null;
    };
    const start = () => {
      cancelHold();
      if (state === 1 && running) return;
      if (state === 0) base = 0;
      run();
      setState(1);
    };
    const pause = () => {
      if (state !== 1 && state !== 3) return;
      cancelHold();
      freeze();
      setState(2);
    };
    const hold = (ms: number, withAd: boolean) => {
      const resume = resumeTo ?? state;
      cancelHold();
      resumeTo = resume;
      freeze();
      setState(3);
      if (withAd) {
        adSince = now();
        setState(1);
      }
      const g = holdGen;
      win.setTimeout(() => {
        if (g !== holdGen || destroyed) return;
        const wasAd = adSince !== null;
        resumeTo = null;
        adSince = null;
        if (wasAd) setState(3);
        if (resume === 1) run();
        setState(resume);
      }, ms);
    };

    const player: FakePlayer = {
      playVideo() {
        if (destroyed) return;
        if (blockAutoplay && !muted) {
          emit("autoplayBlocked", null);
          return;
        }
        start();
      },
      pauseVideo() {
        if (!destroyed) pause();
      },
      seekTo(seconds) {
        if (destroyed) return;
        const next = state === 2 ? 2 : 1;
        cancelHold();
        freeze();
        base = Math.min(config.duration, Math.max(0, seconds));
        if (next === 1 && state !== 1 && blockAutoplay && !muted) {
          emit("autoplayBlocked", null);
          return;
        }
        if (seekLatencyMs > 0) {
          resumeTo = next;
          hold(seekLatencyMs, false);
        } else if (next === 1) {
          run();
          if (state !== 1) setState(1);
        }
      },
      getPlaybackRate: () => rate,
      setPlaybackRate(requested) {
        const rates = [...config.availableRates].sort((a, b) => a - b);
        const lo = rates[0] ?? 1;
        const hi = rates[rates.length - 1] ?? 1;
        let next = Math.min(hi, Math.max(lo, requested));
        if (!config.fineRates) {
          next = next >= 1 ? Math.max(...rates.filter((r) => r <= next)) : Math.min(...rates.filter((r) => r >= next));
        }
        if (next === rate) return;
        if (running) {
          base = contentTime();
          rate = next;
          run();
        } else {
          rate = next;
        }
        emit("rate", next);
      },
      getAvailablePlaybackRates: () => [...config.availableRates],
      getCurrentTime: () => (adSince === null ? contentTime() : Math.min(config.adDuration, (now() - adSince) / 1000)),
      getDuration: () => (adSince === null ? config.duration : config.adDuration),
      getPlayerState: () => state,
      mute() {
        muted = true;
      },
      unMute() {
        muted = false;
      },
      isMuted: () => muted,
      setVolume(v) {
        volume = Math.round(Math.min(100, Math.max(0, v)));
      },
      getVolume: () => volume,
      getVideoData: () =>
        adSince === null
          ? { video_id: videoId, title: "Fake video (e2e)", author: "omega-share e2e" }
          : { video_id: config.adVideoId, title: "Fake ad (e2e)", author: "" },
      getIframe: () => frame,
      destroy() {
        destroyed = true;
        cancelHold();
        freeze();
        if (current?.player === player) current = null;
      },
    };

    current = {
      player,
      playing: () => state === 1 && adSince === null,
      muted: () => muted,
      hold,
      start,
      pause,
      halt() {
        cancelHold();
        freeze();
      },
      emit,
    };
    win.setTimeout(() => {
      if (!destroyed) emit("ready", null);
    }, config.readyDelayMs);
    return player;
  }

  const hooks: FakeYtHooks = {
    buffering(ms) {
      need().hold(ms, false);
    },
    ad(ms) {
      need().hold(ms, true);
    },
    autoplayBlocked() {
      blockAutoplay = true;
      if (current?.playing() && !current.muted()) {
        current.pause();
        current.emit("autoplayBlocked", null);
      }
    },
    allowAutoplay() {
      blockAutoplay = false;
    },
    error(code) {
      const p = need();
      p.halt();
      p.emit("error", code);
    },
    seekLatency(ms) {
      seekLatencyMs = Math.max(0, ms);
    },
    clickToggle() {
      const p = need();
      if (p.player.getPlayerState() === 1) p.pause();
      else p.start();
    },
    configure(next) {
      Object.assign(config, next);
    },
    get currentTime() {
      return current?.player.getCurrentTime() ?? 0;
    },
    get rate() {
      return current?.player.getPlaybackRate() ?? 1;
    },
    get state() {
      return current?.player.getPlayerState() ?? -1;
    },
    get events() {
      return log;
    },
    get player() {
      return current?.player ?? null;
    },
  };

  // `new YT.Player(...)` on a plain function that returns an object yields that object.
  const Player = function (el: string | FrameLike, options?: PlayerOptions) {
    return createPlayer(el, options);
  } as unknown as FakeYtNamespace["Player"];
  win.YT = {
    Player,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
    loaded: 1,
    ready(cb) {
      cb();
    },
  };
  win.__fakeYt = hooks;
  win.onYouTubeIframeAPIReady?.();
}

declare global {
  interface Window {
    YT?: FakeYtNamespace;
    __fakeYt?: FakeYtHooks;
    onYouTubeIframeAPIReady?: () => void;
  }
}
