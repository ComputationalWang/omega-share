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
  readonly history: { readonly state: unknown; pushState(state: unknown, unused: string): void; back(): void };
  readonly window: { addEventListener(type: "popstate", fn: (ev: { readonly state: unknown }) => void): void };
  readonly orientation: OrientationLike | undefined;
  readonly onChange: (mode: FullscreenMode) => void;
}

export interface Fullscreen {
  mode(): FullscreenMode;
  enter(): Promise<void>;
  exit(): void;
  toggle(): Promise<void>;
  /** A key pressed anywhere: F toggles (not while `typing` in a field), Esc leaves the pseudo mode. True if handled. */
  key(key: string, typing: boolean): boolean;
}

const ours = (state: unknown): boolean => typeof state === "object" && state !== null && STATE_KEY in state;

export function createFullscreen(env: FullscreenEnv): Fullscreen {
  let mode: FullscreenMode = "off";
  let entering = false;
  const set = (next: FullscreenMode): void => {
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
    if (mode === "pseudo" && !ours(ev.state)) set("off");
  });

  const enter = async (): Promise<void> => {
    if (mode !== "off" || entering) return;
    entering = true;
    try {
      const request = env.target.requestFullscreen;
      if (env.document.fullscreenEnabled !== false && request !== undefined) {
        try {
          await request.call(env.target, { navigationUI: "hide" });
          set("native");
          await lockLandscape();
          return;
        } catch {
          // Refused (no user activation, a policy, iOS): the CSS mode below.
        }
      }
      env.history.pushState({ [STATE_KEY]: true }, "");
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
      if (ours(env.history.state)) env.history.back();
      else set("off");
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
    key(key, typing) {
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
