import { asVimeoNamespace, type VimeoNamespace } from "./vimeo-types";

/** The served SDK, allowed as an exact file by the CSP (ADR 0014 §5, research M2 §4.5). */
export const VIMEO_SDK_URL = "https://player.vimeo.com/api/player.js";
/** Past this the room plays the video without sync, with a notice (as for YouTube and Twitch). */
export const VIMEO_LOAD_TIMEOUT_MS = 10_000;

export type VimeoLoad = { readonly ok: true; readonly vimeo: VimeoNamespace } | { readonly ok: false; readonly reason: "timeout" | "error" | "invalid" };

export interface VimeoLoaderEnv<Timer> {
  /** `window.Vimeo`, which player.js sets when it runs. */
  readGlobal(): unknown;
  insertScript(src: string, onLoad: () => void, onError: () => void): void;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(t: Timer): void;
}

/**
 * Returns `load()`, which injects player.js at most once and resolves when it has run. Call it only
 * once there is a Vimeo embed; the result (success or failure) is kept for the page's lifetime.
 */
export function createVimeoLoader<Timer>(env: VimeoLoaderEnv<Timer>): () => Promise<VimeoLoad> {
  let loading: Promise<VimeoLoad> | null = null;
  return () => (loading ??= start(env));
}

function start<Timer>(env: VimeoLoaderEnv<Timer>): Promise<VimeoLoad> {
  const existing = asVimeoNamespace(env.readGlobal());
  if (existing !== null) return Promise.resolve({ ok: true, vimeo: existing });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: VimeoLoad) => {
      if (done) return;
      done = true;
      env.clearTimeout(timer);
      resolve(r);
    };
    const timer = env.setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, VIMEO_LOAD_TIMEOUT_MS);
    env.insertScript(
      VIMEO_SDK_URL,
      () => {
        const vm = asVimeoNamespace(env.readGlobal());
        finish(vm === null ? { ok: false, reason: "invalid" } : { ok: true, vimeo: vm });
      },
      () => {
        finish({ ok: false, reason: "error" });
      },
    );
  });
}

let browserLoader: (() => Promise<VimeoLoad>) | null = null;

/** The page-wide loader. Browser only. */
export function loadVimeoApi(): Promise<VimeoLoad> {
  browserLoader ??= createVimeoLoader<number>({
    // Not declared on Window: the e2e fake types its own `Vimeo` global. Read as unknown and guard.
    readGlobal: (): unknown => Reflect.get(window, "Vimeo"),
    insertScript(src, onLoad, onError) {
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.onload = onLoad;
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
