import { describe, expect, test } from "bun:test";
import { FLOOR_CELLS, type MemberId } from "@omega/shared";
import { createSound, SOUND_MUTED_KEY, SOUND_VOLUME_KEY, type AudioCtx, type Sound, type SoundOptions } from "../src/audio/engine";
import { floorKinds } from "../src/audio/floor";
import { parseRecipes, type Recipes } from "../src/audio/recipes";
import { PLACEHOLDER_RECIPES } from "../src/audio/placeholder";
import { emptyPose, type Pose } from "../src/walk/walks";

// OME-1638: the procedural sound engine. Recipes are data (oscillators, noise, envelopes); the engine plays them on a
// WebAudio context made only after the Enter-room gesture, at the user's stored volume, never more than 4 voices at once
// (the nearest win). Footfalls and sit/stand come from the walk poses the animator already draws, so no timers.

interface FakeParam {
  value: number;
  setValueAtTime(v: number, t: number): void;
  linearRampToValueAtTime(v: number, t: number): void;
  exponentialRampToValueAtTime(v: number, t: number): void;
  cancelScheduledValues(t: number): void;
}
const param = (value = 0): FakeParam => ({
  value,
  setValueAtTime(v) {
    this.value = v;
  },
  linearRampToValueAtTime: () => undefined,
  exponentialRampToValueAtTime: () => undefined,
  cancelScheduledValues: () => undefined,
});

interface Started {
  readonly kind: "osc" | "noise";
  readonly freq: number;
  readonly at: number;
  stoppedAt: number | null;
}

/** A headless AudioContext: records each source started (its frequency, when) and when it was stopped. */
function fakeContext() {
  const started: Started[] = [];
  const node = () => ({ connect: () => undefined, disconnect: () => undefined });
  const ctx = {
    currentTime: 0,
    state: "running" as AudioContextState,
    sampleRate: 8000,
    resumed: 0,
    destination: node(),
    resume() {
      this.resumed++;
      this.state = "running";
      return Promise.resolve();
    },
    createGain: () => ({ ...node(), gain: param(1) }),
    createBiquadFilter: () => ({ ...node(), type: "lowpass" as BiquadFilterType, frequency: param(), Q: param() }),
    createOscillator() {
      const frequency = param();
      let s: Started | null = null;
      return {
        ...node(),
        type: "sine" as OscillatorType,
        frequency,
        start: (at: number) => {
          s = { kind: "osc" as const, freq: frequency.value, at, stoppedAt: null };
          started.push(s);
        },
        stop: (at: number) => {
          if (s !== null) s.stoppedAt = at;
        },
      };
    },
    createBuffer: (_channels: number, length: number) => {
      const data = new Float32Array(length);
      return { getChannelData: () => data };
    },
    createBufferSource() {
      let s: Started | null = null;
      return {
        ...node(),
        buffer: null as { getChannelData(c: number): Float32Array } | null,
        loop: false,
        start: (at: number) => {
          s = { kind: "noise" as const, freq: 0, at, stoppedAt: null };
          started.push(s);
        },
        stop: (at: number) => {
          if (s !== null) s.stoppedAt = at;
        },
      };
    },
  };
  return { ctx, started };
}

const memory = (init: Record<string, string> = {}) => {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

/** One short sine per name, its frequency the name's tag, so a test can tell which sound played. */
const blip = (freq: number) => ({ gain: 0.5, layers: [{ osc: "sine" as const, freq, env: { a: 0.01, d: 0.1 } }] });
const RECIPES: Recipes = {
  version: 1,
  sounds: {
    "step.wood": blip(101),
    "step.carpet": blip(102),
    "step.tile": blip(103),
    "chair.sit": blip(201),
    "chair.stand": blip(202),
    "ui.tick": blip(301),
    "tone.night": { gain: 0.1, loop: true, layers: [{ osc: "sine", freq: 401, env: { a: 1 } }] },
    "tone.warm": { gain: 0.1, loop: true, layers: [{ osc: "sine", freq: 402, env: { a: 1 } }] },
  },
};

function setup(over: Partial<SoundOptions> = {}) {
  const fake = fakeContext();
  let made = 0;
  const store = memory();
  const sound: Sound = createSound({
    makeContext: () => {
      made++;
      return fake.ctx satisfies AudioCtx;
    },
    recipes: RECIPES,
    store,
    listener: () => ({ x: 0, y: 0 }),
    floorAt: () => "wood",
    ...over,
  });
  return { sound, fake, store, made: () => made, freqs: () => fake.started.map((s) => s.freq) };
}

const me = "m1" as MemberId;
const pose = (p: Partial<Pose>): Pose => ({ ...emptyPose(), ...p });

describe("the sound engine", () => {
  test("makes no AudioContext and plays nothing before the Enter gesture unlocks it", () => {
    const t = setup();
    t.sound.play("ui.tick");
    expect(t.made()).toBe(0);
    t.sound.unlock();
    t.sound.unlock();
    expect(t.made()).toBe(1);
    t.sound.play("ui.tick");
    expect(t.freqs()).toEqual([301]);
  });

  test("a later gesture resumes a context the browser suspended", () => {
    const t = setup();
    t.sound.unlock();
    t.fake.ctx.state = "suspended";
    t.sound.unlock();
    expect(t.fake.ctx.resumed).toBe(1);
  });

  test("an unknown or missing sound is silent", () => {
    const t = setup();
    t.sound.unlock();
    t.sound.play("door");
    expect(t.fake.started).toEqual([]);
  });

  test("is on by default at a modest volume; the volume and mute are stored and parsed, never trusted", () => {
    const t = setup();
    expect(t.sound.volume()).toBe(0.4);
    expect(t.sound.muted()).toBe(false);
    t.sound.setVolume(0.7);
    t.sound.setMuted(true);
    expect(t.store.m.get(SOUND_VOLUME_KEY)).toBe("0.7");
    expect(t.store.m.get(SOUND_MUTED_KEY)).toBe("on");
    const back = setup({ store: memory({ [SOUND_VOLUME_KEY]: "0.7", [SOUND_MUTED_KEY]: "on" }) });
    expect(back.sound.volume()).toBe(0.7);
    expect(back.sound.muted()).toBe(true);
    for (const junk of ["", "loud", "NaN", "-1", "7", "Infinity"]) {
      expect(setup({ store: memory({ [SOUND_VOLUME_KEY]: junk, [SOUND_MUTED_KEY]: "yes" }) }).sound.volume()).toBe(0.4);
    }
    expect(setup({ store: memory({ [SOUND_MUTED_KEY]: "yes" }) }).sound.muted()).toBe(false);
    const blocked = { getItem: (): string | null => { throw new Error("blocked"); }, setItem: (): void => { throw new Error("blocked"); } };
    const off = setup({ store: blocked });
    expect(off.sound.volume()).toBe(0.4);
    off.sound.setVolume(0.2);
    expect(off.sound.volume()).toBe(0.2);
  });

  test("muted plays nothing at all", () => {
    const t = setup();
    t.sound.unlock();
    t.sound.setMuted(true);
    t.sound.play("ui.tick");
    expect(t.fake.started).toEqual([]);
    t.sound.setMuted(false);
    t.sound.play("ui.tick");
    expect(t.freqs()).toEqual([301]);
  });

  test("plays at most 4 voices: a nearer sound takes the farthest one's place, a farther one is dropped", () => {
    const t = setup();
    t.sound.unlock();
    for (const [i, d] of [10, 40, 20, 30].entries()) t.sound.play(["step.wood", "step.carpet", "step.tile", "chair.sit"][i] ?? "", d);
    t.sound.play("chair.stand", 5);
    // step.carpet (40 px away) was cut (a short fade) for the nearer chair.
    expect(t.fake.started.find((s) => s.freq === 102)?.stoppedAt).toBeLessThan(0.05);
    expect(t.freqs()).toContain(202);
    t.sound.play("ui.tick", 100);
    expect(t.freqs()).not.toContain(301);
    // Once they have ended, there's room again.
    t.fake.ctx.currentTime = 5;
    t.sound.play("ui.tick", 100);
    expect(t.freqs()).toContain(301);
  });
});

describe("walk sounds from the drawn poses", () => {
  test("a footfall on each half of the walk cycle, on the floor under the walker, none on the first pose", () => {
    const t = setup({ floorAt: (p) => (p.x > 50 ? "carpet" : "wood") });
    t.sound.unlock();
    t.sound.pose(me, pose({ walking: true, step: 2 }));
    expect(t.freqs()).toEqual([]);
    t.sound.pose(me, pose({ walking: true, step: 3 }));
    expect(t.freqs()).toEqual([]);
    t.sound.pose(me, pose({ walking: true, step: 4 }));
    expect(t.freqs()).toEqual([101]);
    t.sound.pose(me, pose({ walking: true, step: 4 }));
    t.sound.pose(me, pose({ walking: true, step: 6 }));
    expect(t.freqs()).toEqual([101]);
    t.sound.pose(me, pose({ walking: true, step: 0, x: 60 }));
    expect(t.freqs()).toEqual([101, 102]);
  });

  test("the first step of a walk is a footfall too", () => {
    const t = setup({ floorAt: () => "tile" });
    t.sound.unlock();
    t.sound.pose(me, pose({}));
    t.sound.pose(me, pose({ walking: true, step: 0 }));
    expect(t.freqs()).toEqual([103]);
  });

  test("sitting down and getting up", () => {
    const t = setup();
    t.sound.unlock();
    t.sound.pose(me, pose({ walking: true, step: 1 }));
    t.sound.pose(me, pose({ sitting: true }));
    t.sound.pose(me, pose({ sitting: true }));
    expect(t.freqs()).toEqual([201]);
    t.sound.pose(me, pose({}));
    expect(t.freqs()).toEqual([201, 202]);
  });

  test("a walker far away loses to near ones once 4 voices play", () => {
    const t = setup({ listener: () => ({ x: 0, y: 0 }) });
    t.sound.unlock();
    const ids: MemberId[] = ["a", "b", "c", "d", "e"];
    for (const [i, id] of ids.entries()) t.sound.pose(id, pose({ walking: true, step: 1, x: i === 4 ? 500 : i }));
    for (const [i, id] of ids.entries()) t.sound.pose(id, pose({ walking: true, step: 4, x: i === 4 ? 500 : i }));
    expect(t.fake.started).toHaveLength(4);
  });
});

describe("room tone", () => {
  test("loops the mood's tone until the mood changes; no tone for none", () => {
    const t = setup();
    t.sound.unlock();
    t.sound.tone("night");
    t.sound.tone("night");
    expect(t.freqs()).toEqual([401]);
    expect(t.fake.started[0]?.stoppedAt).toBeNull();
    t.sound.tone("warm");
    expect(t.fake.started[0]?.stoppedAt).not.toBeNull();
    expect(t.freqs()).toEqual([401, 402]);
    t.sound.tone("none");
    expect(t.fake.started[1]?.stoppedAt).not.toBeNull();
  });

  test("a mood set before the gesture starts its tone on unlock; mute stops it", () => {
    const t = setup();
    t.sound.tone("night");
    t.sound.unlock();
    expect(t.freqs()).toEqual([401]);
    t.sound.setMuted(true);
    expect(t.fake.started[0]?.stoppedAt).not.toBeNull();
    t.sound.setMuted(false);
    expect(t.freqs()).toEqual([401, 401]);
  });
});

describe("the recipes", () => {
  test("the placeholder recipes parse", () => {
    expect(parseRecipes(PLACEHOLDER_RECIPES)).not.toBeNull();
  });

  test("anything off-format is rejected, not half-played", () => {
    expect(parseRecipes(RECIPES)).not.toBeNull();
    expect(parseRecipes({ version: 2, sounds: {} })).toBeNull();
    expect(parseRecipes({ version: 1, sounds: { x: { gain: 0.5, layers: [{ osc: "sine", freq: 100, env: {}, volume: 1 }] } } })).toBeNull();
    expect(parseRecipes({ version: 1, sounds: { x: { gain: 2, layers: [] } } })).toBeNull();
    expect(parseRecipes({ version: 1, sounds: { x: { gain: 0.5, layers: [{ osc: "organ", freq: 100, env: {} }] } } })).toBeNull();
    expect(parseRecipes({ version: 1, sounds: { x: { gain: 0.5, layers: [{ noise: "white", env: { a: -1 } }] } } })).toBeNull();
    expect(parseRecipes("{}")).toBeNull();
  });
});

describe("floor kinds", () => {
  const cell = (col: number, row: number): number => col * FLOOR_CELLS + row;
  test("wood by default, carpet under rugs and runners, tile on a pad", () => {
    const kinds = floorKinds([
      { kind: "runner", col: 2, row: 3, facing: "ne" },
      { kind: "pad", col: 9, row: 9, facing: "ne" },
      { kind: "sofa", col: 0, row: 0, facing: "ne" },
    ]);
    expect(kinds(cell(0, 0))).toBe("wood");
    expect(kinds(cell(2, 3))).toBe("carpet");
    expect(kinds(cell(4, 4))).toBe("carpet");
    expect(kinds(cell(5, 4))).toBe("wood");
    expect(kinds(cell(9, 9))).toBe("tile");
    expect(kinds(-1)).toBe("wood");
  });
});
