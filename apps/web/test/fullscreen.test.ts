// OME-597 (M7 W2, set k `ui-m7-desktop` / `ui-m7-band`): full screen on our own wrapper (picture + chat strip), never on
// the provider's iframe. Research R-M7a (docs/research/m7-fullscreen-and-popout.md) Q1/Q2 and its platform table:
// desktop and Android get element full screen (Android also tries a landscape lock); where element full screen is
// missing or refused (iPhone Safari), a CSS full-viewport mode with one history entry, so Back leaves it.
// The geometry is `fullscreenLayout` (layout.ts); the mode machine is `createFullscreen` (fullscreen.ts).
import { describe, expect, test } from "bun:test";
import { createFullscreen, type FullscreenEnv, type FullscreenMode } from "../src/fullscreen";
import { CONTROL_BAR_H, fullscreenLayout, type Rect } from "../src/layout";

const intersects = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
const inside = (a: Rect, w: number, h: number): boolean => a.x >= 0 && a.y >= 0 && a.x + a.w <= w && a.y + a.h <= h;
const ratio = (r: Rect): number => r.w / r.h;

describe("fullscreenLayout: strip open beside the picture (ADR 0012: nothing of ours over the player)", () => {
  test("desktop 1280×720 matches set k: a 980×551 picture, the 300 px strip at the right, the shelf under the picture", () => {
    const l = fullscreenLayout(1280, 720, "youtube", "open");
    expect(l.at).toBe("side");
    expect(l.strip).toEqual({ x: 980, y: 0, w: 300, h: 720 });
    expect(l.tv).toMatchObject({ x: 0, w: 980, h: 551 });
    // The picture and its shelf are centred together in the height.
    expect(l.tv.y).toBe(58);
    expect(l.controls).toMatchObject({ y: l.tv.y + l.tv.h + 8, h: CONTROL_BAR_H, x: 38, w: 904 });
  });

  test.each([
    [1280, 720],
    [1920, 1080],
    [1366, 768],
    [1024, 768],
    [844, 390],
    [740, 360],
  ])("at %p×%p: 16:9, at least 356×200, and the picture, shelf and strip never overlap or leave the screen", (w, h) => {
    const l = fullscreenLayout(w, h, "vimeo", "open");
    expect(l.at).toBe("side");
    expect(Math.abs(ratio(l.tv) - 16 / 9)).toBeLessThan(0.01);
    expect(l.tv.w).toBeGreaterThanOrEqual(356);
    expect(l.tv.h).toBeGreaterThanOrEqual(200);
    for (const r of [l.tv, l.controls, l.strip]) expect(inside(r, w, h)).toBe(true);
    expect(intersects(l.tv, l.strip)).toBe(false);
    expect(intersects(l.tv, l.controls)).toBe(false);
    expect(intersects(l.controls, l.strip)).toBe(false);
  });

  test("a phone in landscape (844×390) gets a narrower strip, so the picture keeps most of the screen", () => {
    const l = fullscreenLayout(844, 390, "youtube", "open");
    expect(l.strip.w).toBeLessThan(300);
    expect(l.strip.w).toBeGreaterThanOrEqual(150);
    expect(l.tv.w).toBeGreaterThan(l.strip.w * 2);
  });

  test("portrait (a phone held upright): the strip goes under the picture and fills the rest of the screen", () => {
    const l = fullscreenLayout(390, 844, "youtube", "open");
    expect(l.at).toBe("below");
    expect(l.tv).toMatchObject({ x: 0, y: 0, w: 390, h: 219 });
    expect(l.controls.y).toBeGreaterThanOrEqual(l.tv.y + l.tv.h);
    expect(l.strip.y).toBeGreaterThanOrEqual(l.controls.y + l.controls.h);
    expect(l.strip.y + l.strip.h).toBe(844);
    expect(l.strip).toMatchObject({ x: 0, w: 390 });
  });

  test("Twitch keeps its 534×300 minimum beside the strip; too narrow for both, the strip goes under it", () => {
    const wide = fullscreenLayout(1280, 720, "twitch", "open");
    expect(wide.tv.w).toBeGreaterThanOrEqual(534);
    expect(wide.tv.h).toBeGreaterThanOrEqual(300);
    const tight = fullscreenLayout(700, 400, "twitch", "open");
    expect(tight.tv.w).toBeGreaterThanOrEqual(534);
    expect(tight.tv.h).toBeGreaterThanOrEqual(300);
    expect(intersects(tight.tv, tight.strip)).toBe(false);
  });
});

describe("fullscreenLayout: collapsed to the input bar (the band)", () => {
  test("desktop 1280×720 matches set k: the picture 1187×668 on top, one 44 px band under it across the screen", () => {
    const l = fullscreenLayout(1280, 720, "youtube", "band");
    expect(l.at).toBe("band");
    expect(l.tv).toMatchObject({ x: 46, y: 0, w: 1187, h: 668 });
    const band = { y: 676, h: CONTROL_BAR_H };
    expect(l.controls).toMatchObject({ ...band, x: 38 });
    expect(l.strip).toMatchObject(band);
    // The remote on the left, then the field and keys, to the band's right end.
    expect(l.strip.x).toBeGreaterThan(l.controls.x + l.controls.w);
    expect(l.strip.x + l.strip.w).toBe(1280 - 38);
  });

  test.each([
    [1280, 720],
    [844, 390],
    [390, 844],
  ])("at %p×%p the picture is larger than with the strip open, and nothing overlaps", (w, h) => {
    const open = fullscreenLayout(w, h, "youtube", "open");
    const band = fullscreenLayout(w, h, "youtube", "band");
    expect(band.tv.w).toBeGreaterThanOrEqual(open.tv.w);
    for (const r of [band.tv, band.controls, band.strip]) expect(inside(r, w, h)).toBe(true);
    expect(intersects(band.tv, band.strip)).toBe(false);
    expect(intersects(band.tv, band.controls)).toBe(false);
    expect(intersects(band.controls, band.strip)).toBe(false);
  });
});

/** A fake browser: element full screen (or not), the history stack, orientation lock. */
function setup(opts: { native?: "ok" | "reject" | "missing"; lock?: "ok" | "reject" | "throw" | "missing"; disabled?: boolean } = {}) {
  const native = opts.native ?? "ok";
  const target = { id: "wrap" };
  const nested = { id: "provider-iframe" };
  let fullscreenElement: object | null = null;
  const fsListeners: (() => void)[] = [];
  const popListeners: ((ev: { state: unknown }) => void)[] = [];
  const stack: unknown[] = [null];
  const calls: string[] = [];
  const modes: FullscreenMode[] = [];
  const fire = (): void => {
    for (const f of fsListeners) f();
  };
  const env: FullscreenEnv = {
    target: {
      ...(native === "missing"
        ? {}
        : {
            requestFullscreen: (o) => {
              calls.push(`request:${o?.navigationUI ?? ""}`);
              if (native === "reject") return Promise.reject(new TypeError("Permissions check failed"));
              fullscreenElement = target;
              fire();
              return Promise.resolve();
            },
          }),
    },
    isTarget: (el) => el === target,
    document: {
      ...(opts.disabled === true ? { fullscreenEnabled: false } : { fullscreenEnabled: native !== "missing" }),
      get fullscreenElement() {
        return fullscreenElement;
      },
      exitFullscreen: () => {
        calls.push("exitFullscreen");
        fullscreenElement = null;
        fire();
        return Promise.resolve();
      },
      addEventListener: (_type, fn) => {
        fsListeners.push(fn);
      },
    },
    history: {
      get state() {
        return stack.at(-1);
      },
      pushState: (state) => {
        calls.push("pushState");
        stack.push(state);
      },
      back: () => {
        calls.push("back");
        stack.pop();
        for (const f of popListeners) f({ state: stack.at(-1) });
      },
    },
    window: {
      addEventListener: (_type, fn) => {
        popListeners.push(fn);
      },
    },
    orientation:
      opts.lock === "missing"
        ? {}
        : {
            lock: (o) => {
              calls.push(`lock:${o}`);
              if (opts.lock === "throw") throw new Error("lock is not a function here");
              return opts.lock === "reject" ? Promise.reject(new Error("NotSupportedError")) : Promise.resolve();
            },
            unlock: () => {
              calls.push("unlock");
            },
          },
    onChange: (m) => modes.push(m),
  };
  const fs = createFullscreen(env);
  return {
    fs,
    calls,
    modes,
    target,
    /** Esc / the browser's own UI / Android Back left element full screen. */
    browserExit: (): void => {
      fullscreenElement = null;
      fire();
    },
    /** The provider's own full-screen button: its iframe goes full screen on top of our wrapper. */
    nestedEnter: (): void => {
      fullscreenElement = nested;
      fire();
    },
    nestedExit: (): void => {
      fullscreenElement = target;
      fire();
    },
    /** The Back gesture / button. */
    back: (): void => {
      env.history.back();
    },
    depth: (): number => stack.length,
  };
}

describe("createFullscreen: element full screen (desktop, Android Chrome, iPad)", () => {
  test("enter asks for full screen on our wrapper, hiding the browser's navigation UI, and reports native", async () => {
    const s = setup();
    await s.fs.enter();
    expect(s.calls[0]).toBe("request:hide");
    expect(s.fs.mode()).toBe("native");
    expect(s.modes).toEqual(["native"]);
    // No history entry: the browser owns this mode's exits (Esc, its UI, Android Back).
    expect(s.calls).not.toContain("pushState");
  });

  test("then tries a landscape lock (Android); a rejection or a missing/throwing lock changes nothing", async () => {
    for (const lock of ["ok", "reject", "throw", "missing"] as const) {
      const s = setup({ lock });
      await s.fs.enter();
      expect(s.fs.mode()).toBe("native");
      if (lock !== "missing") expect(s.calls).toContain("lock:landscape");
    }
  });

  test("Esc (or the browser's UI) leaving full screen turns it off and unlocks the orientation", async () => {
    const s = setup();
    await s.fs.enter();
    s.browserExit();
    expect(s.fs.mode()).toBe("off");
    expect(s.modes).toEqual(["native", "off"]);
    expect(s.calls).toContain("unlock");
  });

  test("our exit key leaves through the document, once", async () => {
    const s = setup();
    await s.fs.enter();
    s.fs.exit();
    expect(s.calls.filter((c) => c === "exitFullscreen")).toHaveLength(1);
    expect(s.fs.mode()).toBe("off");
  });

  test("a provider's own full-screen button on top of ours keeps our mode underneath; coming back changes nothing", async () => {
    const s = setup();
    await s.fs.enter();
    s.nestedEnter();
    expect(s.fs.mode()).toBe("native");
    s.nestedExit();
    expect(s.fs.mode()).toBe("native");
    expect(s.modes).toEqual(["native"]);
  });

  test("a provider going full screen on its own, while we are not, is not ours", () => {
    const s = setup();
    s.nestedEnter();
    expect(s.fs.mode()).toBe("off");
    expect(s.modes).toEqual([]);
  });

  test("a second enter while on does nothing; toggle leaves", async () => {
    const s = setup();
    await s.fs.enter();
    await s.fs.enter();
    expect(s.calls.filter((c) => c.startsWith("request"))).toHaveLength(1);
    await s.fs.toggle();
    expect(s.fs.mode()).toBe("off");
  });
});

describe("createFullscreen: CSS full-viewport fallback (iPhone Safari, or element full screen refused)", () => {
  test.each(["missing", "reject"] as const)("element full screen %s: pseudo mode with one history entry", async (native) => {
    const s = setup({ native });
    await s.fs.enter();
    expect(s.fs.mode()).toBe("pseudo");
    expect(s.depth()).toBe(2);
    expect(s.modes).toEqual(["pseudo"]);
  });

  test("fullscreenEnabled false (a frame or policy forbids it): pseudo without asking", async () => {
    const s = setup({ disabled: true });
    await s.fs.enter();
    expect(s.calls.some((c) => c.startsWith("request"))).toBe(false);
    expect(s.fs.mode()).toBe("pseudo");
  });

  test("Back leaves pseudo mode and stays in the room (the entry it pops is ours)", async () => {
    const s = setup({ native: "missing" });
    await s.fs.enter();
    s.back();
    expect(s.fs.mode()).toBe("off");
    expect(s.depth()).toBe(1);
  });

  test("our exit key pops our own entry, so a later Back leaves the room as usual", async () => {
    const s = setup({ native: "missing" });
    await s.fs.enter();
    s.fs.exit();
    expect(s.calls).toContain("back");
    expect(s.fs.mode()).toBe("off");
    expect(s.depth()).toBe(1);
  });

  test("no orientation lock without element full screen", async () => {
    const s = setup({ native: "missing" });
    await s.fs.enter();
    expect(s.calls.some((c) => c.startsWith("lock"))).toBe(false);
  });
});

describe("createFullscreen: keys", () => {
  test("F toggles when focus is not in a text field; typing an F does not", async () => {
    const s = setup();
    expect(s.fs.key("f", true)).toBe(false);
    expect(s.fs.mode()).toBe("off");
    expect(s.fs.key("f", false)).toBe(true);
    await Promise.resolve();
    expect(s.fs.mode()).toBe("native");
    expect(s.fs.key("F", false)).toBe(true);
    expect(s.fs.mode()).toBe("off");
  });

  test("Esc leaves pseudo mode (the browser handles it in element full screen)", async () => {
    const s = setup({ native: "missing" });
    await s.fs.enter();
    expect(s.fs.key("Escape", true)).toBe(true);
    expect(s.fs.mode()).toBe("off");
    const n = setup();
    await n.fs.enter();
    expect(n.fs.key("Escape", false)).toBe(false);
  });

  test("Esc while off is not ours", () => {
    expect(setup().fs.key("Escape", false)).toBe(false);
  });
});
