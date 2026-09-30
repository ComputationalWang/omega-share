// OME-210: headed Chromium (the real-provider runs) goes to a virtual X display, not the desktop, so nothing pops up or steals focus.
// The browser stays headed: real players can behave differently headless. How-to: docs/qa/headed-on-xvfb.md.
export type HeadedDisplay = "xvfb" | "desktop" | "fallback";
export type Env = Readonly<Record<string, string | undefined>>;
/** Set by the wrapper on the child so specs can check they were launched through it. */
export const DISPLAY_ENV = "OMEGA_HEADED_DISPLAY";
/** `E2E_REAL_ON_DESKTOP=1` opts out: run on your real desktop to watch. */
export const ON_DESKTOP_ENV = "E2E_REAL_ON_DESKTOP";
/** xvfb-run's default screen is 640×480; the Desktop Chrome viewport is 1280×720. */
export const XVFB_SCREEN = "1920x1080x24";
/** The host is a Wayland session: with these set, Chromium ignores the Xvfb DISPLAY ("Failed to connect to Wayland display"). */
const WAYLAND_VARS: readonly string[] = ["WAYLAND_DISPLAY", "ELECTRON_OZONE_PLATFORM_HINT", "XDG_BACKEND"];

export interface HeadedPlan {
  readonly display: HeadedDisplay;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  /** One line for stderr: where the windows go and how to change that. */
  readonly notice: string | null;
}

function copy(env: Env, display: HeadedDisplay, drop: readonly string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.includes(k)) out[k] = v;
  out[DISPLAY_ENV] = display;
  return out;
}

/** What to spawn for `command`: under `xvfb-run -a` with the board's X11 recipe, or as-is on the desktop (opt-in or no xvfb-run). */
export function planHeadedRun(command: readonly string[], env: Env, xvfbRun: string | null): HeadedPlan {
  if (command.length === 0) throw new Error("headed: no command given (usage: bun e2e/support/headed.ts <command> [args…])");
  if (env[ON_DESKTOP_ENV] === "1") {
    return { display: "desktop", argv: [...command], env: copy(env, "desktop"), notice: `headed: ${ON_DESKTOP_ENV}=1, Chromium windows open on your desktop.` };
  }
  if (xvfbRun === null) {
    return {
      display: "fallback",
      argv: [...command],
      env: copy(env, "fallback"),
      notice: "headed: xvfb-run not found, so Chromium windows open on your desktop. Install it (Arch: xorg-server-xvfb, Debian/Ubuntu: xvfb) to keep them off-screen.",
    };
  }
  const out = copy(env, "xvfb", WAYLAND_VARS);
  out["OZONE_PLATFORM"] = "x11";
  out["XDG_SESSION_TYPE"] = "x11";
  return {
    display: "xvfb",
    argv: [xvfbRun, "-a", "-s", `-screen 0 ${XVFB_SCREEN}`, ...command],
    env: out,
    notice: `headed: on a virtual display (xvfb-run, ${XVFB_SCREEN}). To watch on your desktop: ${ON_DESKTOP_ENV}=1.`,
  };
}

/** Why a headed launch with this env would open a window on the desktop uninvited, or null when it's fine. */
export function desktopLeak(env: Env): string | null {
  const display = env[DISPLAY_ENV];
  if (display === "desktop" || display === "fallback") return null;
  if (display === "xvfb" && WAYLAND_VARS.every((k) => env[k] === undefined)) return null;
  return "Headed Chromium outside the Xvfb wrapper would open windows on the desktop. Run `bun run e2e:real` (or `bun e2e/support/headed.ts <command>`); set E2E_REAL_ON_DESKTOP=1 to watch on the desktop.";
}
