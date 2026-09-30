import type { Embed, Provider } from "@omega/shared";
import type { TvFrame } from "../tv";
import type { PlayerAdapter } from "./adapter";

/** Where a player goes: our own iframe (YouTube, Vimeo) or a fresh container the SDK renders into (Twitch). */
export interface MountTarget {
  readonly iframe: HTMLIFrameElement | null;
  readonly container: HTMLElement;
}

export interface MountContext<E extends Embed = Embed> {
  readonly embed: E;
  /** `tvFrame(embed)`: what was rendered for this embed. */
  readonly frame: TvFrame;
  readonly target: MountTarget;
  /** Monotonic ms. */
  readonly now: () => number;
}

/**
 * unsupported: no adapter for this provider yet. load-failed/timeout: the adapter module or the
 * provider's SDK didn't load. invalid: the frame or the rendered player isn't the room's video.
 */
export type MountFailure = "unsupported" | "load-failed" | "timeout" | "invalid";
export type MountResult = { readonly ok: true; readonly player: PlayerAdapter } | { readonly ok: false; readonly reason: MountFailure };

/** Builds a provider's adapter. It loads the provider's SDK itself, only when called. */
export type AdapterFactory<E extends Embed = Embed> = (c: MountContext<E>) => Promise<MountResult>;

/** Provider → lazy import of its factory, so each provider's code and SDK load only when its embed is shown. */
export type AdapterRegistry = { readonly [P in Provider]: () => Promise<AdapterFactory<Extract<Embed, { provider: P }>>> };

/** The page's registry. */
export const PLAYERS: AdapterRegistry = {
  youtube: () => import("./youtube").then((m) => m.mountYouTube),
  twitch: () => import("./twitch").then((m) => m.mountTwitch),
  vimeo: () => import("./vimeo").then((m) => m.mountVimeo),
};

/**
 * Returns `mount(c)`: resolves the embed's provider factory (each module imported at most once) and runs it.
 * Never rejects. The caller passes `frame = tvFrame(embed)`; only the frame kind is re-checked here.
 */
export function createPlayerMounter(reg: AdapterRegistry): (c: MountContext) => Promise<MountResult> {
  const youtube = once(reg.youtube);
  const twitch = once(reg.twitch);
  const vimeo = once(reg.vimeo);
  return (c) => {
    const e = c.embed;
    if (c.frame.kind !== (e.provider === "twitch" ? "twitch" : "iframe")) return Promise.resolve({ ok: false, reason: "invalid" });
    switch (e.provider) {
      case "youtube":
        return run(youtube, { ...c, embed: e });
      case "twitch":
        return run(twitch, { ...c, embed: e });
      case "vimeo":
        return run(vimeo, { ...c, embed: e });
    }
  };
}

async function run<E extends Embed>(load: () => Promise<AdapterFactory<E>>, c: MountContext<E>): Promise<MountResult> {
  let factory: AdapterFactory<E>;
  try {
    factory = await load();
  } catch {
    return { ok: false, reason: "load-failed" };
  }
  try {
    // A throwing SDK constructor must still end in a notice, not an unhandled rejection.
    return await factory(c);
  } catch {
    return { ok: false, reason: "load-failed" };
  }
}

/** Memoises `f()`; a rejected load (offline, deploy in flight) is retried by the next call. */
function once<T>(f: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => {
    if (p !== null) return p;
    const next = f();
    p = next;
    next.catch(() => {
      if (p === next) p = null;
    });
    return next;
  };
}
