/** The window and `runtime` the frame script uses; injected so it can be tested without a browser. */
export interface FrameEnv {
  readonly win: Window & typeof globalThis;
  readonly runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(l: (m: unknown) => void): void; removeListener(l: (m: unknown) => void): void };
  };
}

/**
 * The frame script (ADR 0057 §3, §5): the background injects it into every frame of the room tab it has host access
 * to with `scripting.executeScript({ func, args: [host] })`, so it runs only in the unlocked host's frames there. It
 * reads and drives that frame's first `<video>` and talks only to the background.
 *
 * `executeScript` serializes the function: it must not use anything from outside its own body, not even an import
 * (a test runs it from its source). The limits mirror `@omega/shared` (MAX_POSITION_S, PLAYBACK_RATE_MIN/MAX).
 */
export function frameSync(host: string, env?: FrameEnv): void {
  const win = env?.win ?? window;
  if (win.top === win || win.location.hostname !== host) return;
  const ext = globalThis as unknown as { browser?: { runtime: FrameEnv["runtime"] }; chrome: { runtime: FrameEnv["runtime"] } };
  const runtime = env?.runtime ?? ext.browser?.runtime ?? ext.chrome.runtime;
  const source = "omega-share";
  const MAX_POSITION_S = 43_200;
  const EVENTS = ["play", "pause", "playing", "waiting", "seeked", "ratechange", "ended", "durationchange", "loadedmetadata", "volumechange", "emptied"];
  const INTENTS = ["play", "pause", "seeked"];

  // A second injection (the page attached again) replaces this one.
  const slot = win as unknown as { omegaFrameStop?: () => void };
  slot.omegaFrameStop?.();

  let video: HTMLVideoElement | null = null;
  // Events our own commands will cause: their echoes are reported, never sent back as intents.
  const echoes = new Set<string>();
  const send = (message: unknown): void => {
    try {
      runtime.sendMessage(message).catch(() => undefined);
    } catch {
      stop(); // the extension was reloaded: this copy is orphaned
    }
  };
  const report = (): void => {
    if (video === null) return;
    const duration = video.duration;
    send({
      source,
      kind: "frame-state",
      host,
      state: video.ended ? "ended" : video.paused ? "paused" : video.readyState < 3 ? "buffering" : "playing",
      position: Math.min(Math.max(video.currentTime, 0), MAX_POSITION_S),
      rate: Math.min(Math.max(video.playbackRate, 0.25), 2),
      duration: Number.isFinite(duration) ? duration : null,
      live: duration === Infinity,
      muted: video.muted,
    });
  };
  const onEvent = (event: Event): void => {
    if (video === null) return;
    // Only a real click or key press in this frame counts: the host's own script can't fake user activation.
    if (!echoes.delete(event.type) && INTENTS.includes(event.type) && win.navigator.userActivation.isActive) {
      send({ source, kind: "frame-intent", host, playing: !video.paused, position: Math.min(Math.max(video.currentTime, 0), MAX_POSITION_S) });
    }
    report();
  };
  const use = (next: HTMLVideoElement | null): void => {
    if (next === video) return;
    for (const type of EVENTS) video?.removeEventListener(type, onEvent);
    if (video !== null && next === null) send({ source, kind: "frame-lost", host });
    video = next;
    echoes.clear();
    for (const type of EVENTS) video?.addEventListener(type, onEvent);
    // A video already loaded and paused fires nothing more: report it now so the page can attach.
    report();
  };

  const onCommand = (raw: unknown): void => {
    if (typeof raw !== "object" || raw === null) return;
    const m = raw as { source?: unknown; kind?: unknown; host?: unknown; op?: unknown; value?: unknown };
    if (m.source !== source) return;
    if (m.kind === "frame-detach") {
      stop();
      return;
    }
    if (m.kind !== "frame-command" || m.host !== host || video === null) return;
    const value = typeof m.value === "number" && Number.isFinite(m.value) ? m.value : null;
    if (m.op === "play") {
      if (video.paused) echoes.add("play");
      video.play().catch(report);
    } else if (m.op === "pause") {
      if (!video.paused) echoes.add("pause");
      video.pause();
    } else if (m.op === "seek" && value !== null) {
      echoes.add("seeked");
      video.currentTime = value;
    } else if (m.op === "rate" && value !== null) {
      video.playbackRate = value;
    } else if (m.op === "volume" && value !== null) {
      video.volume = Math.min(Math.max(value, 0), 100) / 100;
    } else if (m.op === "unmute") {
      video.muted = false;
    }
  };

  const observer = new win.MutationObserver(() => {
    use(win.document.querySelector("video"));
  });
  const timer = win.setInterval(() => {
    if (video?.paused === false) report();
  }, 1000);
  const onHide = (): void => {
    if (video !== null) send({ source, kind: "frame-lost", host });
  };
  function stop(): void {
    observer.disconnect();
    win.clearInterval(timer);
    win.removeEventListener("pagehide", onHide);
    runtime.onMessage.removeListener(onCommand);
    for (const type of EVENTS) video?.removeEventListener(type, onEvent);
    video = null;
    if (slot.omegaFrameStop === stop) delete slot.omegaFrameStop;
  }

  slot.omegaFrameStop = stop;
  runtime.onMessage.addListener(onCommand);
  win.addEventListener("pagehide", onHide);
  observer.observe(win.document, { childList: true, subtree: true });
  use(win.document.querySelector("video"));
}
