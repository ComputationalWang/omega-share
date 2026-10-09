// Full screen (OME-597, M7 W2; research R-M7a Q1/Q2): on our own wrapper (picture + chat strip), never on the provider's
// iframe, so nothing is reparented, the iframe never reloads and sync keeps running. Element full screen where the
// browser has it (desktop, Android Chrome, iPad); Android also tries a landscape lock, whose failure changes nothing.
// Where it's missing or refused (iPhone Safari), "pseudo": the same layout as a CSS full-viewport page (room.ts,
// style.css .is-pseudo-fs) with one history entry, so the Back gesture leaves the mode instead of the room.
// The browser owns element full screen's exits (Esc, its UI, Android Back): the mode follows `fullscreenchange`.

export type FullscreenMode = "off" | "native" | "pseudo";

/** Our history entry's marker in `history.state`. */
const STATE_KEY = "omegaFullscreen";

/** `screen.orientation`'s lock is not in every lib.dom (nor every browser): typed and checked here. */
export interface OrientationLike {
  readonly lock?: (orientation: "landscape") => Promise<void>;
  readonly unlock?: () => void;
}

export interface FullscreenEnv {
  readonly target: { readonly requestFullscreen?: (options?: FullscreenOptions) => Promise<void> };
  /** Is this `document.fullscreenElement` our wrapper? */
  readonly isTarget: (el: unknown) => boolean;
  readonly document: {
    readonly fullscreenEnabled?: boolean;
    readonly fullscreenElement: unknown;
    exitFullscreen(): Promise<void>;
    addEventListener(type: "fullscreenchange", fn: () => void): void;
  };
  readonly history: { readonly state: unknown; pushState(state: unknown, unused: string): void; replaceState(state: unknown, unused: string): void; back(): void };
  readonly window: { addEventListener(type: "popstate", fn: (ev: { readonly state: unknown }) => void): void };
  readonly orientation: OrientationLike | undefined;
  readonly onChange: (mode: FullscreenMode) => void;
}

export interface Fullscreen {
  mode(): FullscreenMode;
  enter(): Promise<void>;
  exit(): void;
  toggle(): Promise<void>;
  /**
   * A key pressed anywhere: F toggles (not while `typing` in a field), Esc leaves the pseudo mode. True if handled.
   * A held key's repeats are swallowed: one toggle per press.
   */
  key(key: string, typing: boolean, repeat?: boolean): boolean;
}

const marked = (state: unknown): state is Record<string, unknown> => typeof state === "object" && state !== null && STATE_KEY in state;
/** Each entry we push carries its own token: an entry left marked by an earlier page load (a reload mid-mode) isn't ours. */
let nextToken = Date.now();

export function createFullscreen(env: FullscreenEnv): Fullscreen {
  // A reload in the CSS mode lands on our old entry: it's the page's own entry now, so drop the marker.
  const start = env.history.state;
  if (marked(start)) {
    const rest: Record<string, unknown> = { ...start };
    Reflect.deleteProperty(rest, STATE_KEY);
    env.history.replaceState(Object.keys(rest).length > 0 ? rest : null, "");
  }
  /** The token on the entry this mode pushed, or null. */
  let token: number | null = null;
  const ours = (state: unknown): boolean => token !== null && marked(state) && state[STATE_KEY] === token;
  let mode: FullscreenMode = "off";
  let entering = false;
  /** Our history entry is being popped: its popstate is on the way, so another exit must not pop the room's. */
  let popping = false;
  const set = (next: FullscreenMode): void => {
    if (next === "off") {
      popping = false;
      token = null;
    }
    if (next === mode) return;
    mode = next;
    env.onChange(next);
  };

  const lockLandscape = async (): Promise<void> => {
    try {
      await env.orientation?.lock?.("landscape");
    } catch {
      // Desktop browsers reject, iOS has no lock: the layout follows the device's rotation instead.
    }
  };

  env.document.addEventListener("fullscreenchange", () => {
    const el = env.document.fullscreenElement;
    if (el === null || el === undefined) {
      if (mode === "native") {
        try {
          env.orientation?.unlock?.();
        } catch {
          // Nothing was locked.
        }
        set("off");
      }
    } else if (env.isTarget(el)) set("native");
    // Anything else is a provider's own full screen (its iframe), on top of ours or on its own: not our mode.
  });
  env.window.addEventListener("popstate", (ev) => {
    // Leaving our entry (Back, or our own pop) ends the mode; so does any pop we asked for.
    if (mode === "pseudo" && (popping || !ours(ev.state))) set("off");
  });

  const enter = async (): Promise<void> => {
    if (mode !== "off" || entering) return;
    entering = true;
    try {
      const request = env.target.requestFullscreen;
      if (env.document.fullscreenEnabled !== false && request !== undefined) {
        try {
          await request.call(env.target, { navigationUI: "hide" });
          // Esc may have left again before this promise settled: trust the document, not the promise.
          if (!env.isTarget(env.document.fullscreenElement)) return;
          set("native");
          await lockLandscape();
          return;
        } catch {
          // Refused (no user activation, a policy, iOS): the CSS mode below.
        }
      }
      token = ++nextToken;
      env.history.pushState({ [STATE_KEY]: token }, "");
      set("pseudo");
    } finally {
      entering = false;
    }
  };

  const exit = (): void => {
    if (mode === "native") {
      // The fullscreenchange that follows turns the mode off.
      env.document.exitFullscreen().catch(() => {
        set("off");
      });
    } else if (mode === "pseudo") {
      // Pop our own entry (its popstate turns the mode off), so a later Back leaves the room as usual.
      if (popping) return;
      if (ours(env.history.state)) {
        popping = true;
        env.history.back();
      } else set("off");
    }
  };

  return {
    mode: () => mode,
    enter,
    exit,
    toggle: () => {
      if (mode === "off") return enter();
      exit();
      return Promise.resolve();
    },
    key(key, typing, repeat = false) {
      const ownsKey = (key === "Escape" && mode === "pseudo") || ((key === "f" || key === "F") && !typing);
      if (ownsKey && repeat) return true;
      if (key === "Escape" && mode === "pseudo") {
        exit();
        return true;
      }
      if ((key === "f" || key === "F") && !typing) {
        if (mode === "off") void enter();
        else exit();
        return true;
      }
      return false;
    },
  };
}
