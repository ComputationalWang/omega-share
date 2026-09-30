// OME-210: headed real-provider runs on a virtual X display. Stub: the tests come first.
export type HeadedDisplay = "xvfb" | "desktop" | "fallback";
export type Env = Readonly<Record<string, string | undefined>>;
export const DISPLAY_ENV = "OMEGA_HEADED_DISPLAY";
export const ON_DESKTOP_ENV = "E2E_REAL_ON_DESKTOP";
export const XVFB_SCREEN = "1920x1080x24";

export interface HeadedPlan {
  readonly display: HeadedDisplay;
  readonly argv: readonly string[];
  readonly env: Record<string, string>;
  readonly notice: string | null;
}

export function planHeadedRun(_command: readonly string[], _env: Env, _xvfbRun: string | null): HeadedPlan {
  throw new Error("not implemented");
}

export function desktopLeak(_env: Env): string | null {
  throw new Error("not implemented");
}
