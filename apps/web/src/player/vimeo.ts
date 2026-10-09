import { playbackCaps, type Embed } from "@omega/shared";
import type { PlayerAdapter, PlayerErrorReason, PlayerEvent, PlayerState } from "./adapter";
import { NO_QUALITIES, parseQualities, sameQualities, type QualityOption } from "./quality";
import type { AdapterFactory } from "./registry";
import { loadVimeoApi, type VimeoLoad } from "./vimeo-loader";
import type { VimeoNamespace } from "./vimeo-types";

/** Play/pause events this soon after our own command are its echo, not the user (research M2 §1.3). */
export const ECHO_WINDOW_MS = 1000;
/** The first `seeked` this soon after our own seek is its echo. */
export const SEEK_ECHO_MS = 5000;
/**
 * A `seeked` that lands this close to where the media already was is player.js skipping a gap in the stream
 * (vimeo.com/1084537 jumps 19.48 → 20.93 s by itself, OME-324), not the user: no intent, the sync loop absorbs it.
 */
export const GAP_JUMP_S = 2;
/** No answer from the iframe by then (blocked, wrong domain, gone) → the notice path, as for Twitch. */
export const READY_TIMEOUT_MS = 10_000;
/** `time()` extrapolates the last pushed time by at most this (research M2 §6.2). */
const MAX_EXTRAPOLATE_S = 1;
/** Offered once the rate probe succeeds: Vimeo takes 0–2 (research M2 §1.2); the loop nudges on its 0.05 grid. */
export const VIMEO_RATES: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 2];
const ONE: readonly number[] = [1];
/** Every SDK event we listen to. */
const EVENTS = ["play", "playing", "pause", "ended", "timeupdate", "seeked", "bufferstart", "bufferend", "playbackratechange", "qualitychange", "error"] as const;
type VimeoEventName = (typeof EVENTS)[number];

export type VimeoEmbed = Extract<Embed, { provider: "vimeo" }>;

export interface VimeoAttachOptions<Timer> {
  readonly embed: VimeoEmbed;
  /** Monotonic ms. */
  readonly now: () => number;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
}

/**
 * Attach the official Vimeo SDK to the iframe `tvFrame()` built (ADR 0014 §5), never letting it build one.
 * The SDK is the only `message` listener: it drops anything not from a Vimeo origin **and** our iframe's
 * `contentWindow` (research M2 §4.4). Ready = the iframe answered, plays the room's video, and the rate
 * probe settled: accepted → rate nudges, rejected (free-plan owner) → `rates()` is `[1]`, so seek-only.
 */
export function attachVimeo<Timer>(vm: VimeoNamespace, iframe: HTMLIFrameElement, o: VimeoAttachOptions<Timer>): PlayerAdapter {
  const player = new vm.Player(iframe);
  const listeners = new Set<(e: PlayerEvent) => void>();
  let isReady = false;
  let destroyed = false;
  /** Ready failed or timed out: this player never becomes usable. */
  let failed = false;
  let rateOk = false;
  let rate = 1;
  let contentDuration = 0;
  let phase: "unstarted" | "playing" | "paused" | "ended" = "unstarted";
  let buffering = false;
  let autoplayRetried = false;
  /** What our last play/pause should have produced; null until we've issued one (autoplay at load is not an intent). */
  let expected: "playing" | "paused" | null = null;
  let lastCommandAt = Number.NEGATIVE_INFINITY;
  /** Last playing/paused from the SDK's events; null after load or end. Only a change between them can be the user. */
  let settled: "playing" | "paused" | null = null;
  let seekSentAt = Number.NEGATIVE_INFINITY;
  // Media clock: the last pushed time and when it arrived; time() extrapolates from there.
  let base = 0;
  let baseAt = o.now();
  /** `time()` just before the last push moved `base`: a skip's `timeupdate` can arrive ahead of its `seeked`. */
  let pushedFrom = 0;
  /** Per-viewer quality (OME-599): empty until getQualities() answers, and for good once a setQuality is refused. */
  let qualities: readonly QualityOption[] = NO_QUALITIES;
  let quality: string | null = null;
  let qualityRefused = false;

  const emit = (e: PlayerEvent) => {
    if (destroyed) return;
    for (const l of listeners) l(e);
  };
  const fail = (reason: PlayerErrorReason, code: string) => {
    if (destroyed || failed || isReady) return;
    failed = true;
    o.clearTimeout(readyTimer);
    emit({ type: "error", reason, code });
  };
  const usable = () => isReady && !destroyed;
  /** Re-read after each await: destroy() or the ready timeout may have run meanwhile. */
  const gone = () => destroyed || failed;
  const command = (exp: "playing" | "paused") => {
    expected = exp;
    lastCommandAt = o.now();
  };

  /** Take `seconds`/`duration` from a push. Garbage keeps the last good values. */
  const take = (data: unknown): void => {
    if (typeof data !== "object" || data === null) return;
    const s = "seconds" in data ? data.seconds : undefined;
    if (typeof s === "number" && Number.isFinite(s) && s >= 0) {
      pushedFrom = time();
      base = s;
      baseAt = o.now();
    }
    if (contentDuration === 0 && "duration" in data) learnDuration(data.duration);
  };
  function learnDuration(d: unknown): void {
    if (typeof d === "number" && Number.isFinite(d) && d > 0) contentDuration = d;
  }
  function moving(): boolean {
    return phase === "playing" && !buffering;
  }
  function time(): number {
    if (!isReady) return 0;
    if (!moving()) return base;
    return base + Math.min(MAX_EXTRAPOLATE_S, ((o.now() - baseAt) / 1000) * rate);
  }
  function state(): PlayerState {
    if (!isReady) return "unstarted";
    if (buffering && phase !== "ended") return "buffering";
    return phase;
  }

  const setQualities = (next: readonly QualityOption[], cur: string | null): void => {
    if (sameQualities(next, qualities) && cur === quality) return;
    qualities = next;
    quality = cur;
    emit({ type: "quality" });
  };
  /**
   * One round trip after ready; never per tick. The active entry is the one playing. A video lists its qualities even
   * when its owner's plan may not set them (QA OME-661), so before any key shows, setQuality(the active id) — a no-op
   * where allowed — has to pass. No active entry: nothing safe to probe with, so no key.
   */
  const readQualities = async (): Promise<void> => {
    const list: unknown = await Promise.resolve()
      .then(() => player.getQualities())
      .catch(() => null);
    if (gone() || qualityRefused) return;
    const next = parseQualities(list, "id", "label");
    let cur: string | null = null;
    if (Array.isArray(list)) {
      for (const q of list as readonly unknown[]) {
        if (typeof q !== "object" || q === null || !("active" in q) || q.active !== true || !("id" in q)) continue;
        const id = q.id;
        if (typeof id === "string" && next.some((o) => o.id === id)) cur = id;
      }
    }
    if (cur === null) return;
    const allowed = await player.setQuality(cur).then(
      () => true,
      () => false,
    );
    // No option is listed yet, so set() can't have refused in between.
    if (gone()) return;
    if (!allowed) {
      qualityRefused = true;
      return;
    }
    setQualities(next, cur);
  };

  /** A play/pause event: ours (echo) or the user's (intent). */
  const settle = (s: "playing" | "paused", data: unknown): void => {
    take(data);
    phase = s;
    emit({ type: "state", state: state() });
    const from = settled;
    settled = s;
    if (from === null || from === s || expected === null || s === expected) return;
    if (o.now() - lastCommandAt < ECHO_WINDOW_MS) return;
    expected = s;
    emit({ type: "intent", playing: s === "playing", position: time() });
  };

  const handlers: Readonly<Record<VimeoEventName, (data?: unknown) => void>> = {
    play: (d) => {
      settle("playing", d);
    },
    playing: (d) => {
      settle("playing", d);
    },
    pause: (d) => {
      settle("paused", d);
    },
    ended: (d) => {
      take(d);
      phase = "ended";
      settled = null;
      emit({ type: "state", state: state() });
    },
    timeupdate: take,
    seeked: (d) => {
      const now = o.now();
      if (now - seekSentAt < SEEK_ECHO_MS) {
        seekSentAt = Number.NEGATIVE_INFINITY;
        take(d);
        return;
      }
      const pushed = base;
      const from = time();
      take(d);
      // Measure from before the jump, whether its timeupdate came first (base already there) or not.
      if (Math.abs(base - (base === pushed ? pushedFrom : from)) <= GAP_JUMP_S) return;
      if (expected === null || settled === null) return;
      emit({ type: "intent", playing: settled === "playing", position: base });
    },
    bufferstart: () => {
      buffering = true;
      emit({ type: "state", state: state() });
    },
    bufferend: () => {
      buffering = false;
      baseAt = o.now();
      emit({ type: "state", state: state() });
    },
    qualitychange: (d) => {
      const q = typeof d === "object" && d !== null && "quality" in d ? d.quality : undefined;
      if (typeof q === "string" && qualities.some((o) => o.id === q)) setQualities(qualities, q);
    },
    playbackratechange: (d) => {
      const r = typeof d === "object" && d !== null && "playbackRate" in d ? d.playbackRate : undefined;
      if (typeof r === "number" && Number.isFinite(r) && r > 0) rate = r;
    },
    error: (d) => {
      if (typeof d !== "object" || d === null) return;
      // The SDK also fires `error` for a failed method call; that one rejects the call's promise, handled there.
      if ("method" in d && typeof d.method === "string" && d.method !== "") return;
      const code = errorName(d);
      emit({ type: "error", reason: errorReason(code), code });
    },
  };
  for (const name of EVENTS) player.on(name, handlers[name]);

  const readyTimer = o.setTimeout(() => {
    fail("timeout", "ready-timeout");
  }, READY_TIMEOUT_MS);

  const startup = async (): Promise<void> => {
    if (gone()) return;
    const id = await player.getVideoId().catch(() => null);
    if (gone()) return;
    if ((typeof id === "number" || typeof id === "string") && String(id) !== o.embed.videoId) {
      fail("other", "wrong-video");
      return;
    }
    rateOk = await player.setPlaybackRate(1).then(
      () => true,
      () => false,
    );
    learnDuration(await player.getDuration().catch(() => 0));
    if (gone()) return;
    isReady = true;
    o.clearTimeout(readyTimer);
    emit({ type: "ready" });
    void readQualities();
  };
  player.ready().then(startup, (err: unknown) => {
    const code = errorName(err);
    fail(errorReason(code), code);
  });

  const onPlayRejected = (err: unknown): void => {
    if (destroyed) return;
    const code = errorName(err);
    const reason = errorReason(code);
    if (reason !== "other") {
      emit({ type: "error", reason, code });
      return;
    }
    // Anything else is the browser blocking sound (research M2 §2.3): retry muted, once.
    if (autoplayRetried) return;
    autoplayRetried = true;
    command("playing");
    emit({ type: "autoplay-blocked" });
    void player
      .setMuted(true)
      .then(() => (destroyed ? undefined : player.play()))
      .catch(ignore);
  };

  return {
    caps: playbackCaps(o.embed),
    ready: usable,
    play() {
      if (!usable()) return;
      command("playing");
      player.play().catch(onPlayRejected);
    },
    pause() {
      if (!usable()) return;
      command("paused");
      player.pause().catch(ignore);
    },
    seek(seconds) {
      if (!usable()) return;
      seekSentAt = o.now();
      base = seconds;
      baseAt = seekSentAt;
      player.setCurrentTime(seconds).catch(ignore);
    },
    setRate(r) {
      if (!usable() || !rateOk) return;
      player.setPlaybackRate(r).then(() => {
        rate = r;
      }, ignore);
    },
    unmute() {
      if (!usable()) return;
      player.setMuted(false).catch(ignore);
    },
    setVolume(volume) {
      if (!usable()) return;
      player.setVolume(volume / 100).catch(ignore);
    },
    time,
    duration: () => contentDuration,
    state,
    rates: () => (rateOk ? VIMEO_RATES : ONE),
    quality: {
      options: () => qualities,
      current: () => quality,
      set(id) {
        if (!usable() || qualityRefused || !qualities.some((q) => q.id === id)) return;
        player.setQuality(id).catch(() => {
          // The owner's plan doesn't allow it: hide the picker for this video.
          if (destroyed) return;
          qualityRefused = true;
          setQualities(NO_QUALITIES, null);
        });
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
      listeners.clear();
      for (const name of EVENTS) player.off(name, handlers[name]);
      player.destroy().catch(ignore);
    },
  };
}

function ignore(): void {
  // A rejected command: the sync loop re-checks the player every tick, so there's nothing to do.
}

function errorName(e: unknown): string {
  const n = typeof e === "object" && e !== null && "name" in e ? e.name : undefined;
  return typeof n === "string" && n !== "" ? n : "unknown";
}

/** Vimeo's named errors (research M2 §2.2): private or domain-restricted → refused, password → restricted. */
function errorReason(name: string): PlayerErrorReason {
  if (name === "PrivacyError") return "refused";
  if (name === "NotFoundError") return "not-found";
  return name === "PasswordError" ? "restricted" : "other";
}

/** The registry's Vimeo factory, over any SDK loader (tests pass a fake). */
export function createVimeoMount(load: () => Promise<VimeoLoad>): AdapterFactory<VimeoEmbed> {
  return async (c) => {
    const iframe = c.target.iframe;
    if (c.frame.kind !== "iframe" || iframe === null) return { ok: false, reason: "invalid" };
    const r = await load();
    if (!r.ok) return { ok: false, reason: r.reason === "timeout" ? "timeout" : "load-failed" };
    const player = attachVimeo(r.vimeo, iframe, {
      embed: c.embed,
      now: c.now,
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => {
        clearTimeout(t);
      },
    });
    return { ok: true, player };
  };
}

/** Loads the SDK only now (the first Vimeo embed on the page) and attaches it to our iframe. */
export const mountVimeo: AdapterFactory<VimeoEmbed> = createVimeoMount(loadVimeoApi);
