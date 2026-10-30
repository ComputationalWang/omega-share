import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { SoundSetting } from "../src/help/dialog";

// OME-1968 (OME-1965 #3): the room sounds' mute and volume, in the room bar next to Leave, not only inside Help. They
// drive the engine's one master gain (OME-1638, audio.test.ts holds the gain and the stored setting); the key only
// mirrors it. Hidden until the lazy sound engine is in.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function fake(volume = 0.4, muted = false): SoundSetting & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    volume: () => volume,
    setVolume(v) {
      volume = v;
      calls.push(`volume ${String(v)}`);
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
      calls.push(`muted ${String(m)}`);
    },
  };
}

async function setup(s: SoundSetting | null) {
  const { createSoundKey } = await import("../src/controls/sound-key");
  let current = s;
  const key = createSoundKey(() => current);
  document.body.replaceChildren(key.root);
  const toggle = key.root.querySelector("button");
  const slider = key.root.querySelector("input");
  if (toggle?.dataset["testid"] !== "sound-key" || slider?.dataset["testid"] !== "sound-key-volume") throw new Error("no sound key");
  const load = (n: SoundSetting): void => {
    current = n;
    key.sync();
  };
  return { key, toggle, slider, load };
}

describe("room sounds key (OME-1968)", () => {
  test("hidden until the sound engine is loaded, then shows its volume (0–100) and mute", async () => {
    const t = await setup(null);
    t.key.sync();
    expect(t.key.root.hidden).toBe(true);
    t.load(fake(0.4, false));
    expect(t.key.root.hidden).toBe(false);
    expect(t.slider.min).toBe("0");
    expect(t.slider.max).toBe("100");
    expect(t.slider.value).toBe("40");
    expect(t.toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("labelled controls: a pressed toggle and a named slider", async () => {
    const t = await setup(fake());
    t.key.sync();
    expect(t.key.root.getAttribute("role")).toBe("group");
    expect(t.key.root.getAttribute("aria-label")).toBe("Room sounds");
    expect(t.toggle.getAttribute("aria-label")).toBe("Mute room sounds");
    expect(t.slider.getAttribute("aria-label")).toBe("Room sounds volume");
  });

  test("the toggle mutes and unmutes the engine, aria-pressed follows", async () => {
    const s = fake();
    const t = await setup(s);
    t.key.sync();
    t.toggle.click();
    expect(s.calls).toEqual(["muted true"]);
    expect(t.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(t.toggle.getAttribute("aria-label")).toBe("Unmute room sounds");
    t.toggle.click();
    expect(s.calls).toEqual(["muted true", "muted false"]);
    expect(t.toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("the slider sets the engine's volume in 0..1; moving it while muted unmutes", async () => {
    const s = fake(0.4, true);
    const t = await setup(s);
    t.key.sync();
    expect(t.toggle.getAttribute("aria-pressed")).toBe("true");
    t.slider.value = "75";
    t.slider.dispatchEvent(new Event("input"));
    expect(s.calls).toEqual(["muted false", "volume 0.75"]);
    expect(t.toggle.getAttribute("aria-pressed")).toBe("false");
  });

  test("sync picks up a change made elsewhere (the Help dialog's settings)", async () => {
    const s = fake(0.4, false);
    const t = await setup(s);
    t.key.sync();
    s.setMuted(true);
    s.setVolume(0.1);
    t.key.sync();
    expect(t.toggle.getAttribute("aria-pressed")).toBe("true");
    expect(t.slider.value).toBe("10");
  });
});
