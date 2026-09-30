// Fake Vimeo Player SDK, player.js v2.30-style (M2, OME-121). Spec: docs/research/m2-twitch-vimeo-sync.md §1.2, §1.4, §7.1.
// Served at https://player.vimeo.com/api/player.js by e2e/support/network.ts as `(${installFakeVimeo})(window)`,
// so installFakeVimeo must stay self-contained: no references to anything outside its own body.

/** The slice of an iframe element the real SDK reads. */
export interface VimeoElementLike {
  nodeType: number;
  tagName: string;
  getAttribute(name: string): string | null;
}

export interface FakeVimeoHost {
  performance: { now(): number };
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout?(handle: unknown): void;
  document?: { getElementById(id: string): VimeoElementLike | null };
  Vimeo?: FakeVimeoNamespace;
  __fakeVimeo?: FakeVimeoHooks;
}

export type VimeoListener = (data?: unknown) => void;

/** Every method returns a Promise and waits for ready(), like the real callMethod. */
export interface VimeoPlayer {
  ready(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  getPaused(): Promise<boolean>;
  getEnded(): Promise<boolean>;
  getCurrentTime(): Promise<number>;
  setCurrentTime(seconds: number): Promise<number>;
  getDuration(): Promise<number>;
  getBuffered(): Promise<number[][]>;
  getPlaybackRate(): Promise<number>;
  setPlaybackRate(rate: number): Promise<number>;
  getVolume(): Promise<number>;
  setVolume(volume: number): Promise<number>;
  getMuted(): Promise<boolean>;
  setMuted(muted: boolean): Promise<boolean>;
  getVideoId(): Promise<number>;
  destroy(): Promise<void>;
  on(event: string, callback: VimeoListener): void;
  off(event: string, callback?: VimeoListener): void;
}

export type VimeoPlayerCtor = new (target: string | VimeoElementLike, options?: Record<string, unknown>) => VimeoPlayer;

export interface FakeVimeoNamespace {
  Player: VimeoPlayerCtor;
}

/** Payload of play, playing, pause, ended, seeking, seeked and timeupdate. */
export interface VimeoTimeData {
  seconds: number;
  percent: number;
  duration: number;
}

/** One entry per event the fake emitted, in order; `t` is performance.now() at emit time. */
export interface FakeVimeoEvent {
  type: string;
  data: unknown;
  t: number;
}

/** One entry per API method the app called (never for user* hooks). */
export interface FakeVimeoCall {
  name: string;
  args: unknown[];
  t: number;
}

export interface FakeVimeoConfig {
  /** Content duration in seconds. Default 634.5 (Big Buck Bunny). */
  duration: number;
  /** Delay before ready() settles, ms. Default 20. */
  readyDelayMs: number;
  /** timeupdate cadence while playing, ms. Default 250. */
  timeupdateMs: number;
}

/** window.__fakeVimeo: fault injection and read-outs for the most recently created player. */
export interface FakeVimeoHooks {
  /** Emit bufferstart, freeze the media clock for `ms`, then emit bufferend and resume. */
  buffering(ms: number): void;
  /** ready() (current player if not yet ready, and later ones) rejects with PrivacyError. */
  privacy(): void;
  /** ready() rejects with PasswordError. */
  password(): void;
  /** Unmuted play() rejects NotAllowedError from now on. If playing unmuted, pause and emit pause. */
  autoplayBlocked(): void;
  /** Lift the autoplayBlocked() policy. */
  allowAutoplay(): void;
  /** true: setPlaybackRate is honoured (1x otherwise rejects Error). Default false. */
  rateAllowed(allowed: boolean): void;
  /** true: setPlaybackRate resolves and echoes, but the media clock keeps playing at 1x (implies rateAllowed). */
  rateIgnored(ignored: boolean): void;
  /** Later setCurrentTime calls: seeking, bufferstart, `ms`, bufferend, seeked. 0 = instant (default). */
  seekLatency(ms: number): void;
  /** User gestures inside the player: same events as the methods, not recorded in `calls`, ignore the autoplay block. */
  userPause(): void;
  userPlay(): void;
  userSeek(seconds: number): void;
  configure(config: Partial<FakeVimeoConfig>): void;
  /** True media time, synchronous. */
  readonly currentTime: number;
  /** Effective clock rate (1 when rateIgnored). */
  readonly rate: number;
  readonly paused: boolean;
  readonly events: readonly FakeVimeoEvent[];
  readonly calls: readonly FakeVimeoCall[];
  /** Query of the iframe src of the last created player. */
  readonly query: Record<string, string>;
  readonly src: string;
  readonly player: VimeoPlayer | null;
}

export function installFakeVimeo(win: FakeVimeoHost): void {
  if (win.Vimeo) return;
  const config: FakeVimeoConfig = { duration: 634.5, readyDelayMs: 20, timeupdateMs: 250 };
  const events: FakeVimeoEvent[] = [];
  const calls: FakeVimeoCall[] = [];
  const cache = new WeakMap<object, VimeoPlayer>();
  const now = () => win.performance.now();
  let refusal: "PrivacyError" | "PasswordError" | null = null;
  let blockAutoplay = false;
  let allowRate = false;
  let ignoreRate = false;
  let seekLatencyMs = 0;
  let lastSrc = "";
  let lastQuery: Record<string, string> = {};

  interface Internal {
    player: VimeoPlayer;
    time(): number;
    effRate(): number;
    isPaused(): boolean;
    isMuted(): boolean;
    play(): void;
    pause(): void;
    seek(seconds: number): Promise<number>;
    hold(ms: number): void;
  }
  let current: Internal | null = null;
  const need = (): Internal => {
    if (!current) throw new Error("__fakeVimeo: no Vimeo.Player has been created yet");
    return current;
  };
  const fail = (name: string, message: string): Error => {
    const e = new Error(message);
    e.name = name;
    return e;
  };

  function parseQuery(src: string): Record<string, string> {
    const out: Record<string, string> = {};
    const q = src.split("#")[0]?.split("?")[1] ?? "";
    for (const pair of q.split("&")) {
      if (!pair) continue;
      const i = pair.indexOf("=");
      const dec = (s: string) => {
        try { return decodeURIComponent(s); } catch { return s; }
      };
      out[dec(i < 0 ? pair : pair.slice(0, i))] = i < 0 ? "" : dec(pair.slice(i + 1));
    }
    return out;
  }

  function createPlayer(target: string | VimeoElementLike): VimeoPlayer {
    const found = typeof target === "string" ? (win.document?.getElementById(target) ?? null) : target;
    if (found?.nodeType !== 1) throw new TypeError("You must pass either a valid element or a valid id.");
    const cached = cache.get(found);
    if (cached) return cached;
    const src = found.getAttribute("src") ?? "";
    const id = /^https:\/\/player\.vimeo\.com\/video\/(\d+)(?:[/?#]|$)/.exec(src)?.[1];
    if (found.tagName.toUpperCase() !== "IFRAME" || id === undefined) throw new Error("The player element passed isn’t a Vimeo embed.");
    lastSrc = src;
    lastQuery = parseQuery(src);

    const listeners = new Map<string, VimeoListener[]>();
    let paused = true;
    let ended = false;
    let holding = false;
    let muted = false;
    let volume = 1;
    let rate = 1;
    let eff = 1;
    let destroyed = false;
    // Media clock: while running, time = base + elapsed wall seconds * eff.
    let base = 0;
    let since = 0;
    let running = false;
    let clockGen = 0;
    let holdGen = 0;

    const time = () => (running ? Math.min(config.duration, base + ((now() - since) / 1000) * eff) : base);
    const timeData = (): VimeoTimeData => ({ seconds: time(), percent: time() / config.duration, duration: config.duration });
    const emit = (type: string, data?: unknown) => {
      if (destroyed) return;
      events.push({ type, data, t: now() });
      for (const cb of [...(listeners.get(type) ?? [])]) cb(data);
    };
    /** Rebase the clock after any state change and (re)arm the end and timeupdate timers. */
    const settle = () => {
      base = time();
      running = false;
      const gen = (clockGen += 1);
      if (paused || holding || destroyed) return;
      since = now();
      running = true;
      win.setTimeout(() => {
        if (gen !== clockGen) return;
        base = config.duration;
        running = false;
        paused = true;
        ended = true;
        emit("timeupdate", timeData());
        emit("ended", timeData());
      }, (Math.max(0, config.duration - base) / eff) * 1000);
      const tick = () => {
        win.setTimeout(() => {
          if (gen !== clockGen) return;
          emit("timeupdate", timeData());
          tick();
        }, config.timeupdateMs);
      };
      tick();
    };
    const play = () => {
      if (!paused) return;
      if (ended) {
        base = 0;
        ended = false;
      }
      paused = false;
      settle();
      emit("play", timeData());
      emit("playing", timeData());
    };
    const pause = () => {
      if (paused) return;
      paused = true;
      settle();
      emit("pause", timeData());
    };
    const hold = (ms: number, then?: () => void) => {
      const gen = (holdGen += 1);
      holding = true;
      settle();
      emit("bufferstart");
      win.setTimeout(() => {
        if (gen !== holdGen || destroyed) return;
        holding = false;
        settle();
        emit("bufferend");
        then?.();
      }, ms);
    };
    const seek = (seconds: number) =>
      new Promise<number>((resolve) => {
        const to = Math.min(config.duration, Math.max(0, seconds));
        base = to;
        running = false;
        if (to < config.duration) ended = false;
        emit("seeking", { seconds: to, percent: to / config.duration, duration: config.duration });
        const done = () => {
          emit("seeked", timeData());
          resolve(to);
        };
        if (seekLatencyMs > 0) {
          holdGen += 1;
          holding = true;
          settle();
          emit("bufferstart");
          const gen = holdGen;
          win.setTimeout(() => {
            if (gen !== holdGen || destroyed) return;
            holding = false;
            settle();
            emit("bufferend");
            done();
          }, seekLatencyMs);
        } else {
          settle();
          win.setTimeout(done, 0);
        }
      });

    // ready() settles once; every other method chains on it, so a refusal rejects them with the same error.
    const ready = new Promise<void>((resolve, reject) => {
      win.setTimeout(() => {
        if (destroyed) return;
        if (refusal) {
          const err = fail(refusal, refusal === "PrivacyError" ? "The video is private." : "The video is password protected.");
          emit("error", { name: err.name, message: err.message, method: "ready" });
          reject(err);
        } else {
          emit("loaded", { id: Number(id) });
          resolve();
        }
      }, config.readyDelayMs);
    });
    ready.catch(() => undefined);
    const call = <T,>(name: string, args: unknown[], fn: () => T | Promise<T>): Promise<T> => {
      calls.push({ name, args, t: now() });
      return ready.then(fn);
    };

    const player: VimeoPlayer = {
      ready: () => call("ready", [], () => undefined),
      play: () =>
        call("play", [], () => {
          if (blockAutoplay && !muted) throw fail("NotAllowedError", "The play() request was blocked by the autoplay policy.");
          play();
        }),
      pause: () => call("pause", [], pause),
      getPaused: () => call("getPaused", [], () => paused),
      getEnded: () => call("getEnded", [], () => ended),
      getCurrentTime: () => call("getCurrentTime", [], time),
      setCurrentTime: (seconds) =>
        call("setCurrentTime", [seconds], () => {
          if (!(seconds >= 0 && seconds <= config.duration)) throw fail("RangeError", "The time must be between 0 and the duration.");
          return seek(seconds);
        }),
      getDuration: () => call("getDuration", [], () => config.duration),
      getBuffered: () => call("getBuffered", [], () => [[0, time()]]),
      getPlaybackRate: () => call("getPlaybackRate", [], () => rate),
      setPlaybackRate: (requested) =>
        call("setPlaybackRate", [requested], () => {
          if (!(requested >= 0.5 && requested <= 2)) throw fail("RangeError", "The playback rate must be between 0.5 and 2.");
          if (!allowRate && !ignoreRate) throw fail("Error", "Playback rate is not available for this video.");
          rate = requested;
          eff = ignoreRate ? 1 : requested;
          settle();
          emit("playbackratechange", { playbackRate: requested });
          return requested;
        }),
      getVolume: () => call("getVolume", [], () => volume),
      setVolume: (v) =>
        call("setVolume", [v], () => {
          if (!(v >= 0 && v <= 1)) throw fail("RangeError", "The volume must be between 0 and 1.");
          volume = v;
          emit("volumechange", { volume: v });
          return v;
        }),
      getMuted: () => call("getMuted", [], () => muted),
      setMuted: (m) =>
        call("setMuted", [m], () => {
          muted = m;
          return m;
        }),
      getVideoId: () => call("getVideoId", [], () => Number(id)),
      destroy: () =>
        call("destroy", [], () => {
          destroyed = true;
          clockGen += 1;
          holdGen += 1;
          listeners.clear();
          cache.delete(found);
          if (current?.player === player) current = null;
        }),
      on(event, callback) {
        listeners.set(event, [...(listeners.get(event) ?? []), callback]);
      },
      off(event, callback) {
        listeners.set(event, callback ? (listeners.get(event) ?? []).filter((cb) => cb !== callback) : []);
      },
    };

    cache.set(found, player);
    current = { player, time, effRate: () => eff, isPaused: () => paused, isMuted: () => muted, play, pause, seek, hold: (ms) => { hold(ms); } };
    return player;
  }

  const hooks: FakeVimeoHooks = {
    buffering(ms) {
      need().hold(ms);
    },
    privacy() {
      refusal = "PrivacyError";
    },
    password() {
      refusal = "PasswordError";
    },
    autoplayBlocked() {
      blockAutoplay = true;
      if (current && !current.isPaused() && !current.isMuted()) current.pause();
    },
    allowAutoplay() {
      blockAutoplay = false;
    },
    rateAllowed(allowed) {
      allowRate = allowed;
    },
    rateIgnored(ignored) {
      ignoreRate = ignored;
    },
    seekLatency(ms) {
      seekLatencyMs = Math.max(0, ms);
    },
    userPause() {
      need().pause();
    },
    userPlay() {
      need().play();
    },
    userSeek(seconds) {
      void need().seek(seconds);
    },
    configure(next) {
      Object.assign(config, next);
    },
    get currentTime() {
      return current?.time() ?? 0;
    },
    get rate() {
      return current?.effRate() ?? 1;
    },
    get paused() {
      return current?.isPaused() ?? true;
    },
    get events() {
      return events;
    },
    get calls() {
      return calls;
    },
    get query() {
      return lastQuery;
    },
    get src() {
      return lastSrc;
    },
    get player() {
      return current?.player ?? null;
    },
  };

  // `new Vimeo.Player(...)` on a plain function that returns an object yields that object.
  const Player = function (target: string | VimeoElementLike) {
    return createPlayer(target);
  } as unknown as VimeoPlayerCtor;
  win.Vimeo = { Player };
  win.__fakeVimeo = hooks;
}

declare global {
  interface Window {
    Vimeo?: FakeVimeoNamespace;
    __fakeVimeo?: FakeVimeoHooks;
  }
}
