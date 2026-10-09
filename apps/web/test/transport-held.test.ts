import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { PlaybackController, PlaybackView } from "../src/controls/playback";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-507 (ADR 0030, set j): under "only the host controls playback", a guest's shared keys sink into the shelf
// (is-held, aria-disabled, "Only the host controls playback"), the scrubber locks, and the shelf chip reads Host.

const base: PlaybackView = {
  hasVideo: true,
  canControl: true,
  playing: true,
  position: 30,
  duration: 200,
  volume: 100,
  muted: false,
  needsUnmute: false,
  catching: false,
  error: null,
  provider: "youtube",
  live: false,
  seekOnly: false,
  policy: "everyone",
  held: false,
  qualities: [],
  quality: null,
};

async function setup() {
  const { createTransport } = await import("../src/controls/dom");
  const calls: string[] = [];
  const c = {
    togglePlay: () => {
      calls.push("toggle");
      return true;
    },
    seek: () => {
      calls.push("seek");
      return true;
    },
  } as Pick<PlaybackController, "togglePlay" | "seek">;
  const t = createTransport(c);
  document.body.replaceChildren(t.root);
  const key = t.root.querySelector("[data-testid=play-toggle]");
  const seek = t.root.querySelector("[data-testid=seek]");
  const chip = t.root.querySelector(".ui-chip");
  if (!(key instanceof HTMLButtonElement) || !(seek instanceof HTMLInputElement) || !(chip instanceof HTMLElement)) throw new Error("no transport parts");
  return { t, calls, key, seek, chip };
}

describe("shared transport under the control policy", () => {
  test("everyone: wood keys, the Everyone chip", async () => {
    const { t, key, chip } = await setup();
    t.update(base);
    expect(key.classList.contains("is-held")).toBe(false);
    expect(key.getAttribute("aria-disabled")).toBeNull();
    expect(chip.textContent).toBe("Everyone");
  });

  test("held: keys sink (is-held, aria-disabled, off icon) and say why; the scrubber locks; a click sends nothing", async () => {
    const { t, calls, key, seek, chip } = await setup();
    t.update(base);
    t.update({ ...base, canControl: false, policy: "owner", held: true });
    expect(key.classList.contains("is-held")).toBe(true);
    expect(key.getAttribute("aria-disabled")).toBe("true");
    expect(key.ariaLabel).toBe("Only the host controls playback");
    expect(key.querySelector(".ui-icon-pause-off")).not.toBeNull();
    expect(seek.disabled).toBe(true);
    expect(chip.textContent).toBe("Host");
    expect(chip.querySelector(".ui-glyph-host")).not.toBeNull();
    key.click();
    expect(calls).toEqual([]);
  });

  test("the owner of an owner-only room: Host chip, but live wood keys", async () => {
    const { t, key, chip } = await setup();
    t.update({ ...base, policy: "owner", held: false });
    expect(chip.textContent).toBe("Host");
    expect(key.classList.contains("is-held")).toBe(false);
    expect(key.ariaLabel).toBe("Pause for everyone");
  });

  test("released again: keys come back with their normal label", async () => {
    const { t, key, chip } = await setup();
    t.update({ ...base, canControl: false, policy: "owner", held: true });
    t.update(base);
    expect(key.classList.contains("is-held")).toBe(false);
    expect(key.getAttribute("aria-disabled")).toBeNull();
    expect(key.ariaLabel).toBe("Pause for everyone");
    expect(key.querySelector(".ui-icon-pause")).not.toBeNull();
    expect(chip.textContent).toBe("Everyone");
  });
});
