// Fake Twitch Embed/Player JS SDK (M2, OME-121). Spec: docs/research/m2-twitch-vimeo-sync.md §1.1, §1.4, §2.1, §4.1, §7.1.
// Served at https://player.twitch.tv/js/embed/v1.js by e2e/support/network.ts as `(${installFakeTwitch})(window)`,
// so installFakeTwitch must stay self-contained: no references to anything outside its own body.

export type FakeTwitchEventName =
  | "authenticate" | "captions" | "ended" | "error" | "offline" | "online" | "pause" | "play"
  | "playbackBlocked" | "playing" | "video.pause" | "video.play" | "video.ready" | "ready" | "seek";

export type FakeTwitchPlayback = "Idle" | "Ready" | "Buffering" | "Playing" | "Ended";

export interface FakeTwitchEvents {
  readonly AUTHENTICATE: "authenticate";
  readonly CAPTIONS: "captions";
  readonly ENDED: "ended";
  readonly ERROR: "error";
  readonly OFFLINE: "offline";
  readonly ONLINE: "online";
  readonly PAUSE: "pause";
  readonly PLAY: "play";
  readonly PLAYBACK_BLOCKED: "playbackBlocked";
  readonly PLAYING: "playing";
  readonly VIDEO_PAUSE: "video.pause";
  readonly VIDEO_PLAY: "video.play";
  readonly VIDEO_READY: "video.ready";
  readonly READY: "ready";
  readonly SEEK: "seek";
}

/** Element-like surface the fake needs from the DOM (a real HTMLElement satisfies it). */
export interface ElementLike {
  nodeType: number;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: ElementLike): unknown;
}

export interface FakeTwitchHost {
  performance: { now(): number };
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
  document: {
    domain: string;
    location: { href: string };
    getElementById(id: string): ElementLike | null;
    createElement(tag: "iframe"): ElementLike;
    hasStorageAccess?: () => unknown;
    requestStorageAccess?: () => unknown;
  };
  Twitch?: FakeTwitchNamespace;
  __fakeTwitch?: FakeTwitchHooks;
}

export interface TwitchPlayerOptions {
  channel?: string;
  video?: string;
  collection?: string;
  parent?: string | string[];
  width?: number | string;
  height?: number | string;
  muted?: boolean;
  [key: string]: string | number | boolean | string[] | undefined;
}

export interface FakeTwitchPlayerState {
  channelName: string;
  currentTime: number;
  duration: number;
  muted: boolean;
  playback: FakeTwitchPlayback;
  videoID: string;
  volume: number;
  ended: boolean;
  stats: { videoStats: { playbackRate: number } };
}

export interface FakeTwitchPlayer {
  play(): void;
  pause(): void;
  seek(seconds: number): void;
  setMuted(muted: boolean): void;
  getMuted(): boolean;
  setVolume(volume: number): void;
  getVolume(): number;
  getCurrentTime(): number;
  getDuration(): number;
  isPaused(): boolean;
  getEnded(): boolean;
  getChannel(): string;
  getVideo(): string;
  getPlayerState(): FakeTwitchPlayerState;
  getPlaybackStats(): FakeTwitchPlayerState["stats"];
  addEventListener(name: FakeTwitchEventName, cb: (params?: unknown) => void): void;
  removeEventListener(name: FakeTwitchEventName, cb: (params?: unknown) => void): void;
  destroy(): void;
}

export type FakeTwitchEmbed = FakeTwitchPlayer & { getPlayer(): FakeTwitchPlayer };

export interface FakeTwitchNamespace {
  Player: (new (target: string | ElementLike, options: TwitchPlayerOptions) => FakeTwitchPlayer) &
    FakeTwitchEvents & {
      Errors: { ABORTED: 1000; NETWORK: 2000; DECODE: 3000; FORMAT_NOT_SUPPORTED: 4000; CONTENT_NOT_AVAILABLE: 5000; RENDERER_NOT_AVAILABLE: 6000 };
    };
  Embed: (new (target: string | ElementLike, options: TwitchPlayerOptions) => FakeTwitchEmbed) & FakeTwitchEvents;
}

/** One entry per event the fake emitted, in order; `t` is performance.now() at emit time. */
export interface FakeTwitchLoggedEvent {
  type: FakeTwitchEventName;
  params: unknown;
  t: number;
}

/** One entry per command the app called on the player (not user clicks); dropped = received before READY or after destroy. */
export interface FakeTwitchLoggedCommand {
  name: string;
  args: unknown[];
  t: number;
  dropped: boolean;
}

export interface FakeTwitchConfig {
  /** VOD duration in seconds. Default 3600. Live players report 0. */
  duration: number;
  /** Delay before READY, ms. Default 20. */
  readyDelayMs: number;
  /** Interval at which the cached currentTime is refreshed, ms. Default 250. */
  pushIntervalMs: number;
  /** READY never fires (emulates a wrong `parent`); applies to players created later and to one that is not ready yet. Default false. */
  neverReady: boolean;
}

/** window.__fakeTwitch: fault injection and read-outs for the most recently created player. */
export interface FakeTwitchHooks {
  /** playback "Buffering" for `ms` with the clock frozen and NO event (the real SDK has none), then back to the previous playback. */
  buffering(ms: number): void;
  /** Ad for `ms`: playback stays "Playing", clock and cached currentTime frozen, no event; then resumes. */
  ad(ms: number): void;
  /** Emit OFFLINE and halt the clock. */
  offline(): void;
  /** Emit ONLINE and resume the clock if playing. */
  online(): void;
  /** Block unmuted playback from now on. If playing unmuted: go Idle and emit PLAYBACK_BLOCKED; later unmuted play() emits it instead of playing. */
  playbackBlocked(): void;
  /** Lift the playbackBlocked() policy. */
  allowAutoplay(): void;
  /** Emit ERROR with `{ code }` (payload shape is INFERRED; the SDK does not document it) and halt the clock. */
  error(code: number): void;
  /** Shorthand for configure({ neverReady: true }). */
  neverReady(): void;
  /** Later seeks: playback "Buffering" for `ms`, then settle and emit SEEK. 0 = instant (default). */
  seekLatency(ms: number): void;
  /** Clicks inside the player: same events as the commands, not recorded as commands, ignore the autoplay block. */
  userPause(): void;
  userPlay(): void;
  userSeek(seconds: number): void;
  configure(config: Partial<FakeTwitchConfig>): void;
  /** TRUE media time in seconds (getCurrentTime() is the stale cached value). 0 for live. */
  readonly currentTime: number;
  readonly playback: FakeTwitchPlayback;
  readonly events: readonly FakeTwitchLoggedEvent[];
  readonly commands: readonly FakeTwitchLoggedCommand[];
  readonly options: TwitchPlayerOptions | null;
  readonly iframe: ElementLike | null;
  readonly player: FakeTwitchPlayer | null;
}

export function installFakeTwitch(win: FakeTwitchHost): void {
  if (win.Twitch) return;
  const config: FakeTwitchConfig = { duration: 3600, readyDelayMs: 20, pushIntervalMs: 250, neverReady: false };
  const eventLog: FakeTwitchLoggedEvent[] = [];
  const commandLog: FakeTwitchLoggedCommand[] = [];
  const now = () => win.performance.now();
  const doc = win.document;
  let blockAutoplay = false;
  let seekLatencyMs = 0;

  interface Internal {
    player: FakeTwitchPlayer;
    iframe: ElementLike;
    options: TwitchPlayerOptions;
    state: FakeTwitchPlayerState;
    trueTime(): number;
    buffer(ms: number, ad: boolean): void;
    stop(): void;
    resume(): void;
    block(): void;
    reschedule(): void;
    emit(type: FakeTwitchEventName, params?: unknown): void;
    user: { play(): void; pause(): void; seek(s: number): void };
  }
  let current: Internal | null = null;
  const need = (): Internal => {
    if (!current) throw new Error("__fakeTwitch: no Twitch.Player has been created yet");
    return current;
  };

  function createPlayer(target: string | ElementLike, options: TwitchPlayerOptions): FakeTwitchPlayer {
    const host = typeof target === "string" ? doc.getElementById(target) : target;
    if (!host) throw new Error(`Twitch.Player: no element ${typeof target === "string" ? target : "given"}`);
    if (options.channel === undefined && options.video === undefined && options.collection === undefined) {
      throw new Error("Twitch.Player: options need one of channel, video or collection");
    }
    // Same iframe the real SDK builds: options + parent (page domain appended) + referrer, keys sorted, arrays as repeated keys.
    const parents = options.parent === undefined ? [] : Array.isArray(options.parent) ? [...options.parent] : [options.parent];
    if (!parents.includes(doc.domain)) parents.push(doc.domain);
    const query: Record<string, string | number | boolean | string[] | undefined> = { ...options, parent: parents, referrer: doc.location.href };
    const qs = Object.keys(query)
      .sort()
      .flatMap((k) => {
        const v = query[k];
        return v === undefined ? [] : (Array.isArray(v) ? v : [v]).map((x) => `${encodeURIComponent(k)}=${encodeURIComponent(String(x))}`);
      })
      .join("&");
    const iframe = doc.createElement("iframe");
    iframe.setAttribute("src", `https://player.twitch.tv?${qs}`);
    iframe.setAttribute("allowfullscreen", "");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("frameborder", "0");
    iframe.setAttribute("allow", "autoplay; fullscreen");
    iframe.setAttribute("title", "Twitch");
    const storage = typeof doc.hasStorageAccess === "function" && typeof doc.requestStorageAccess === "function";
    iframe.setAttribute(
      "sandbox",
      `allow-modals allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox${storage ? " allow-storage-access-by-user-activation" : ""}`,
    );
    if (options.width !== undefined) iframe.setAttribute("width", String(options.width));
    if (options.height !== undefined) iframe.setAttribute("height", String(options.height));
    host.appendChild(iframe);

    const live = options.video === undefined && options.channel !== undefined;
    const st: FakeTwitchPlayerState = {
      channelName: options.channel ?? "",
      currentTime: 0,
      duration: 0,
      muted: options.muted === true,
      playback: "Idle",
      videoID: options.video ?? "",
      volume: 1,
      ended: false,
      stats: { videoStats: { playbackRate: 1 } },
    };
    const listeners = new Map<FakeTwitchEventName, ((params?: unknown) => void)[]>();
    let ready = false;
    let destroyed = false;
    // Media clock: while running, time = base + elapsed wall seconds (always rate 1). `halted` (offline/error) keeps it stopped.
    let base = 0;
    let since = 0;
    let running = false;
    let halted = false;
    let endGen = 0;
    let holdGen = 0;
    let pushGen = 0;
    let pushTimer: unknown;
    let resumeTo: FakeTwitchPlayback | null = null;

    const dur = () => (live ? 0 : config.duration);
    const trueTime = () => (live ? 0 : running ? Math.min(dur(), base + (now() - since) / 1000) : base);
    const setPlayback = (p: FakeTwitchPlayback) => {
      st.playback = p;
      st.ended = p === "Ended";
    };
    /** Refresh the cached state the getters read (the real SDK pushes it from the iframe). */
    const push = () => {
      st.currentTime = trueTime();
      st.duration = ready ? dur() : 0;
    };
    const schedulePush = () => {
      win.clearTimeout?.(pushTimer);
      const g = (pushGen += 1);
      pushTimer = win.setTimeout(() => {
        if (g !== pushGen || destroyed) return;
        push();
        schedulePush();
      }, config.pushIntervalMs);
    };
    const emit = (type: FakeTwitchEventName, params?: unknown) => {
      if (destroyed) return;
      eventLog.push({ type, params, t: now() });
      for (const cb of [...(listeners.get(type) ?? [])]) cb(params);
    };
    const freeze = () => {
      base = trueTime();
      running = false;
      endGen += 1;
    };
    const run = () => {
      if (halted) return;
      since = now();
      running = true;
      if (live) return;
      const g = (endGen += 1);
      win.setTimeout(() => {
        if (g !== endGen || destroyed) return;
        base = dur();
        running = false;
        setPlayback("Ended");
        push();
        emit("ended");
      }, Math.max(0, dur() - base) * 1000);
    };
    const cancelHold = () => {
      holdGen += 1;
      if (resumeTo !== null) setPlayback(resumeTo);
      resumeTo = null;
    };
    const wantsPlay = () => st.playback === "Playing" || resumeTo === "Playing";
    /** Freeze the clock for `ms` (Buffering, or an ad that keeps playback "Playing"), then restore `resume`. */
    const hold = (ms: number, ad: boolean, resume: FakeTwitchPlayback, done?: () => void) => {
      cancelHold();
      resumeTo = resume;
      freeze();
      if (!ad) setPlayback("Buffering");
      push();
      const g = holdGen;
      win.setTimeout(() => {
        if (g !== holdGen || destroyed) return;
        resumeTo = null;
        setPlayback(resume);
        if (resume === "Playing") run();
        push();
        done?.();
      }, ms);
    };

    const doPlay = (user: boolean) => {
      if (wantsPlay()) return;
      if (blockAutoplay && !st.muted && !user) {
        emit("playbackBlocked");
        return;
      }
      const wasIdle = st.playback === "Idle";
      cancelHold();
      if (st.playback === "Ended") base = 0;
      setPlayback("Playing");
      run();
      push();
      emit("play");
      // Live resume jumps to the live edge: PLAY, SEEK, PLAYING (our choice of order; the SDK does not document it).
      if (live && wasIdle) emit("seek");
      emit("playing");
    };
    const doPause = () => {
      if (!wantsPlay()) return;
      cancelHold();
      freeze();
      setPlayback("Idle");
      push();
      emit("pause");
    };
    const doSeek = (seconds: number) => {
      if (live) return;
      const prev = resumeTo ?? st.playback;
      const next = prev === "Ended" ? "Idle" : prev;
      cancelHold();
      freeze();
      base = Math.min(dur(), Math.max(0, seconds));
      if (seekLatencyMs > 0) {
        hold(seekLatencyMs, false, next, () => { emit("seek", { position: base }); });
        return;
      }
      setPlayback(next);
      if (next === "Playing") run();
      push();
      emit("seek", { position: base });
    };
    /** Commands from the app: always logged, dropped before READY (the real SDK ignores them before init). */
    const command = (name: string, args: unknown[], fn: () => void) => {
      const dropped = !ready || destroyed;
      commandLog.push({ name, args, t: now(), dropped });
      if (!dropped) fn();
    };

    const player: FakeTwitchPlayer = {
      play: () => { command("play", [], () => { doPlay(false); }); },
      pause: () => { command("pause", [], doPause); },
      seek: (s) => { command("seek", [s], () => { doSeek(s); }); },
      setMuted: (m) => { command("setMuted", [m], () => { st.muted = m; }); },
      getMuted: () => st.muted,
      setVolume: (v) => { command("setVolume", [v], () => { st.volume = Math.min(1, Math.max(0, v)); }); },
      getVolume: () => st.volume,
      getCurrentTime: () => st.currentTime,
      getDuration: () => st.duration,
      isPaused: () => st.playback === "Idle",
      getEnded: () => st.ended,
      getChannel: () => st.channelName,
      getVideo: () => st.videoID,
      getPlayerState: () => st,
      getPlaybackStats: () => st.stats,
      addEventListener(name, cb) {
        listeners.set(name, [...(listeners.get(name) ?? []), cb]);
      },
      removeEventListener(name, cb) {
        listeners.set(name, (listeners.get(name) ?? []).filter((f) => f !== cb));
      },
      destroy() {
        cancelHold();
        freeze();
        destroyed = true;
        pushGen += 1;
        win.clearTimeout?.(pushTimer);
        listeners.clear();
        if (current?.player === player) current = null;
      },
    };

    current = {
      player,
      iframe,
      options: { ...options },
      state: st,
      trueTime,
      buffer: (ms, ad) => { hold(ms, ad, resumeTo ?? st.playback); },
      stop() {
        cancelHold();
        freeze();
        halted = true;
        push();
      },
      resume() {
        halted = false;
        if (st.playback === "Playing" && resumeTo === null && !running) run();
      },
      block() {
        if (!wantsPlay() || st.muted) return;
        cancelHold();
        freeze();
        setPlayback("Idle");
        push();
        emit("playbackBlocked");
      },
      reschedule: schedulePush,
      emit,
      user: { play: () => { doPlay(true); }, pause: doPause, seek: doSeek },
    };
    schedulePush();
    win.setTimeout(() => {
      if (destroyed || ready || config.neverReady) return;
      ready = true;
      setPlayback("Ready");
      push();
      emit("ready");
    }, config.readyDelayMs);
    return player;
  }

  const hooks: FakeTwitchHooks = {
    buffering: (ms) => { need().buffer(ms, false); },
    ad: (ms) => { need().buffer(ms, true); },
    offline() {
      const p = need();
      p.stop();
      p.emit("offline");
    },
    online() {
      const p = need();
      p.resume();
      p.emit("online");
    },
    playbackBlocked() {
      blockAutoplay = true;
      current?.block();
    },
    allowAutoplay() {
      blockAutoplay = false;
    },
    error(code) {
      const p = need();
      p.stop();
      p.emit("error", { code });
    },
    neverReady() {
      config.neverReady = true;
    },
    seekLatency(ms) {
      seekLatencyMs = Math.max(0, ms);
    },
    userPause: () => { need().user.pause(); },
    userPlay: () => { need().user.play(); },
    userSeek: (s) => { need().user.seek(s); },
    configure(next) {
      Object.assign(config, next);
      current?.reschedule();
    },
    get currentTime() {
      return current?.trueTime() ?? 0;
    },
    get playback() {
      return current?.state.playback ?? "Idle";
    },
    get events() {
      return eventLog;
    },
    get commands() {
      return commandLog;
    },
    get options() {
      return current?.options ?? null;
    },
    get iframe() {
      return current?.iframe ?? null;
    },
    get player() {
      return current?.player ?? null;
    },
  };

  const EVENTS: FakeTwitchEvents = {
    AUTHENTICATE: "authenticate", CAPTIONS: "captions", ENDED: "ended", ERROR: "error", OFFLINE: "offline", ONLINE: "online",
    PAUSE: "pause", PLAY: "play", PLAYBACK_BLOCKED: "playbackBlocked", PLAYING: "playing", VIDEO_PAUSE: "video.pause",
    VIDEO_PLAY: "video.play", VIDEO_READY: "video.ready", READY: "ready", SEEK: "seek",
  };
  // `new Twitch.Player(...)` on a plain function that returns an object yields that object.
  const Player = Object.assign(
    function (target: string | ElementLike, options: TwitchPlayerOptions) {
      return createPlayer(target, options);
    },
    EVENTS,
    // Values from the SDK enum per research §2.1; verify in Q4.
    { Errors: { ABORTED: 1000, NETWORK: 2000, DECODE: 3000, FORMAT_NOT_SUPPORTED: 4000, CONTENT_NOT_AVAILABLE: 5000, RENDERER_NOT_AVAILABLE: 6000 } },
  ) as unknown as FakeTwitchNamespace["Player"];
  const Embed = Object.assign(function (target: string | ElementLike, options: TwitchPlayerOptions) {
    const p = createPlayer(target, options);
    return Object.assign(p, { getPlayer: () => p });
  }, EVENTS) as unknown as FakeTwitchNamespace["Embed"];
  win.Twitch = { Player, Embed };
  win.__fakeTwitch = hooks;
}

declare global {
  interface Window {
    Twitch?: FakeTwitchNamespace;
    __fakeTwitch?: FakeTwitchHooks;
  }
}
