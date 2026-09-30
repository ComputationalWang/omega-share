import { asYtNamespace, type YtNamespace } from "./youtube-types";

export const IFRAME_API_URL = "https://www.youtube.com/iframe_api";
/** Past this the room plays the video without sync, with a notice (ADR 0011). */
export const LOAD_TIMEOUT_MS = 10_000;

export type YtLoad = { readonly ok: true; readonly yt: YtNamespace } | { readonly ok: false; readonly reason: "timeout" | "error" | "invalid" };

export interface LoaderEnv<Timer> {
  /** Where the API puts `YT` and calls `onYouTubeIframeAPIReady`. */
  readonly win: { YT?: unknown; onYouTubeIframeAPIReady?: unknown };
  insertScript(src: string, onError: () => void): void;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(t: Timer): void;
}

/**
 * Returns `load()`, which injects the IFrame API script at most once and resolves
 * when it's ready. Call it only once there is an embed; the result (success or
 * failure) is kept for the page's lifetime.
 */
export function createYouTubeLoader<Timer>(env: LoaderEnv<Timer>): () => Promise<YtLoad> {
  let loading: Promise<YtLoad> | null = null;
  return () => (loading ??= start(env));
}

function start<Timer>(env: LoaderEnv<Timer>): Promise<YtLoad> {
  const { win } = env;
  const existing = asYtNamespace(win.YT);
  if (existing !== null) return Promise.resolve({ ok: true, yt: existing });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: YtLoad) => {
      if (done) return;
      done = true;
      env.clearTimeout(timer);
      resolve(r);
    };
    const timer = env.setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, LOAD_TIMEOUT_MS);
    const previous = win.onYouTubeIframeAPIReady;
    win.onYouTubeIframeAPIReady = () => {
      // A handler someone else installed first; it takes no arguments.
      if (typeof previous === "function") (previous as () => void)();
      const yt = asYtNamespace(win.YT);
      finish(yt === null ? { ok: false, reason: "invalid" } : { ok: true, yt });
    };
    env.insertScript(IFRAME_API_URL, () => {
      finish({ ok: false, reason: "error" });
    });
  });
}

declare global {
  interface Window {
    YT?: unknown;
    onYouTubeIframeAPIReady?: unknown;
  }
}

let browserLoader: (() => Promise<YtLoad>) | null = null;

/** The page-wide loader. Browser only. */
export function loadYouTubeApi(): Promise<YtLoad> {
  browserLoader ??= createYouTubeLoader<number>({
    win: window,
    insertScript(src, onError) {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onerror = onError;
      document.head.append(s);
    },
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (t) => {
      window.clearTimeout(t);
    },
  });
  return browserLoader();
}
