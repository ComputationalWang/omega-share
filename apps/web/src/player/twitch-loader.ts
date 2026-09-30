import { asTwitchNamespace, type TwitchNamespace } from "./twitch-types";

import { TWITCH_SDK_URL, sdkScriptUrl } from "./sdk-policy";

/** The served SDK, allowed as an exact file by the CSP (research M2 §4.3). */
export { TWITCH_SDK_URL };
/** Past this the room plays the video without sync, with a notice (as for YouTube). */
export const TWITCH_LOAD_TIMEOUT_MS = 10_000;

export type TwitchLoad = { readonly ok: true; readonly twitch: TwitchNamespace } | { readonly ok: false; readonly reason: "timeout" | "error" | "invalid" };

export interface TwitchLoaderEnv<Timer> {
  /** `window.Twitch`, which v1.js sets when it runs. */
  readGlobal(): unknown;
  insertScript(src: string, onLoad: () => void, onError: () => void): void;
  setTimeout(fn: () => void, ms: number): Timer;
  clearTimeout(t: Timer): void;
}

/**
 * Returns `load()`, which injects v1.js at most once and resolves when it has run. Call it only
 * once there is a Twitch embed; the result (success or failure) is kept for the page's lifetime.
 */
export function createTwitchLoader<Timer>(env: TwitchLoaderEnv<Timer>): () => Promise<TwitchLoad> {
  let loading: Promise<TwitchLoad> | null = null;
  return () => (loading ??= start(env));
}

function start<Timer>(env: TwitchLoaderEnv<Timer>): Promise<TwitchLoad> {
  const existing = asTwitchNamespace(env.readGlobal());
  if (existing !== null) return Promise.resolve({ ok: true, twitch: existing });
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: TwitchLoad) => {
      if (done) return;
      done = true;
      env.clearTimeout(timer);
      resolve(r);
    };
    const timer = env.setTimeout(() => {
      finish({ ok: false, reason: "timeout" });
    }, TWITCH_LOAD_TIMEOUT_MS);
    env.insertScript(
      TWITCH_SDK_URL,
      () => {
        const tw = asTwitchNamespace(env.readGlobal());
        finish(tw === null ? { ok: false, reason: "invalid" } : { ok: true, twitch: tw });
      },
      () => {
        finish({ ok: false, reason: "error" });
      },
    );
  });
}

let browserLoader: (() => Promise<TwitchLoad>) | null = null;

/** The page-wide loader. Browser only. */
export function loadTwitchApi(): Promise<TwitchLoad> {
  browserLoader ??= createTwitchLoader<number>({
    // Not declared on Window: the e2e fake types its own `Twitch` global. Read as unknown and guard.
    readGlobal: (): unknown => Reflect.get(window, "Twitch"),
    insertScript(src, onLoad, onError) {
      const s = document.createElement("script");
      Reflect.set(s, "src", sdkScriptUrl(src));
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
