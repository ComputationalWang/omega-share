import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DISPLAY_ENV, ON_DESKTOP_ENV, XVFB_SCREEN, desktopLeak, planHeadedRun } from "./xvfb";

// OME-210: headed real-provider runs go to a virtual X display, never the board's Wayland desktop.
const HOST = {
  PATH: "/usr/bin",
  DISPLAY: ":0",
  WAYLAND_DISPLAY: "wayland-1",
  ELECTRON_OZONE_PLATFORM_HINT: "wayland",
  XDG_BACKEND: "wayland",
  OZONE_PLATFORM: "wayland",
  XDG_SESSION_TYPE: "wayland",
};
const CMD = ["playwright", "test", "--project=e2e-real"];

describe("planHeadedRun", () => {
  test("wraps the command in xvfb-run -a with a desktop-sized screen", () => {
    const plan = planHeadedRun(CMD, HOST, "/usr/bin/xvfb-run");
    expect(plan.display).toBe("xvfb");
    expect(plan.argv).toEqual(["/usr/bin/xvfb-run", "-a", "-s", `-screen 0 ${XVFB_SCREEN}`, ...CMD]);
  });

  test("drops the Wayland variables and forces X11, as in the board's recipe", () => {
    const { env } = planHeadedRun(CMD, HOST, "/usr/bin/xvfb-run");
    expect(env).not.toHaveProperty("WAYLAND_DISPLAY");
    expect(env).not.toHaveProperty("ELECTRON_OZONE_PLATFORM_HINT");
    expect(env).not.toHaveProperty("XDG_BACKEND");
    expect(env["OZONE_PLATFORM"]).toBe("x11");
    expect(env["XDG_SESSION_TYPE"]).toBe("x11");
    expect(env["PATH"]).toBe("/usr/bin");
    expect(env[DISPLAY_ENV]).toBe("xvfb");
  });

  test("does not mutate the caller's env", () => {
    const host = { ...HOST };
    planHeadedRun(CMD, host, "/usr/bin/xvfb-run");
    expect(host).toEqual(HOST);
  });

  test("falls back to the desktop with a clear message when xvfb-run is missing", () => {
    const plan = planHeadedRun(CMD, HOST, null);
    expect(plan.display).toBe("fallback");
    expect(plan.argv).toEqual(CMD);
    expect(plan.env["WAYLAND_DISPLAY"]).toBe("wayland-1");
    expect(plan.env[DISPLAY_ENV]).toBe("fallback");
    expect(plan.notice).toContain("xvfb-run not found");
    expect(plan.notice).toContain("desktop");
  });

  test(`${ON_DESKTOP_ENV}=1 runs on the real desktop even when xvfb-run exists`, () => {
    const plan = planHeadedRun(CMD, { ...HOST, [ON_DESKTOP_ENV]: "1" }, "/usr/bin/xvfb-run");
    expect(plan.display).toBe("desktop");
    expect(plan.argv).toEqual(CMD);
    expect(plan.env["WAYLAND_DISPLAY"]).toBe("wayland-1");
    expect(plan.env[DISPLAY_ENV]).toBe("desktop");
    expect(plan.notice).toContain(ON_DESKTOP_ENV);
  });

  test(`${ON_DESKTOP_ENV}=0 or empty keeps the virtual display`, () => {
    expect(planHeadedRun(CMD, { ...HOST, [ON_DESKTOP_ENV]: "0" }, "/usr/bin/xvfb-run").display).toBe("xvfb");
    expect(planHeadedRun(CMD, { ...HOST, [ON_DESKTOP_ENV]: "" }, "/usr/bin/xvfb-run").display).toBe("xvfb");
  });

  test("the xvfb notice tells you how to watch", () => {
    expect(planHeadedRun(CMD, HOST, "/usr/bin/xvfb-run").notice).toContain(`${ON_DESKTOP_ENV}=1`);
  });

  test("an empty command is an error", () => {
    expect(() => planHeadedRun([], HOST, "/usr/bin/xvfb-run")).toThrow();
  });
});

describe("desktopLeak", () => {
  test("a headed launch outside the wrapper is refused with the command to use", () => {
    expect(desktopLeak(HOST)).toContain("bun run e2e:real");
  });

  test("the wrapper's virtual display passes", () => {
    expect(desktopLeak(planHeadedRun(CMD, HOST, "/usr/bin/xvfb-run").env)).toBeNull();
  });

  test("an explicit desktop opt-in or the no-xvfb fallback passes", () => {
    expect(desktopLeak(planHeadedRun(CMD, { ...HOST, [ON_DESKTOP_ENV]: "1" }, "/usr/bin/xvfb-run").env)).toBeNull();
    expect(desktopLeak(planHeadedRun(CMD, HOST, null).env)).toBeNull();
  });

  test("a forged xvfb marker with Wayland still set is refused", () => {
    expect(desktopLeak({ ...HOST, [DISPLAY_ENV]: "xvfb" })).not.toBeNull();
  });
});

// The CLI end to end: the child really gets the planned env and exit code.
const CLI = join(import.meta.dir, "headed.ts");
const probe = ["bun", "-e", `console.log(JSON.stringify({ m: process.env.${DISPLAY_ENV}, w: process.env.WAYLAND_DISPLAY ?? null, d: process.env.DISPLAY ?? null })); process.exit(3)`];

async function runCli(env: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", CLI, ...probe], { env, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err };
}

const hostEnv = (): Record<string, string> => ({ ...HOST, PATH: process.env["PATH"] ?? "/usr/bin", HOME: process.env["HOME"] ?? "/tmp" });

test("headed.ts passes the child's exit code through and prints the opt-in notice", async () => {
  const r = await runCli({ ...hostEnv(), [ON_DESKTOP_ENV]: "1" });
  expect(r.code).toBe(3);
  expect(JSON.parse(r.out)).toEqual({ m: "desktop", w: "wayland-1", d: ":0" });
  expect(r.err).toContain(ON_DESKTOP_ENV);
});

test.skipIf(Bun.which("xvfb-run") === null)("headed.ts runs the child on a fresh Xvfb display without Wayland", async () => {
  const r = await runCli(hostEnv());
  expect(r.code).toBe(3);
  const seen: unknown = JSON.parse(r.out);
  expect(seen).toMatchObject({ m: "xvfb", w: null });
  expect(seen).not.toMatchObject({ d: ":0" });
}, 20_000);
