import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// The sound palette (OME-1642): WebAudio recipes as data in the OME-1638 engine's format (v1, apps/web/src/audio/FORMAT.md).
const ASSETS = join(import.meta.dir, "..");
const FILE = join(ASSETS, "sound", "recipes.json");
const NAMES = ["step.wood", "step.carpet", "step.tile", "chair.sit", "chair.stand", "door", "ui.tick", "ui.toggle", "ui.error", ...["heart", "laugh", "question", "exclaim", "clap", "wave", "cheer", "yawn", "dance"].map((k) => `emote.${k}`), "tone.warm", "tone.cool", "tone.night", "swell"];
const PEAK = 10 ** (-12 / 20); // -12 dBFS at master volume 1

type Layer = Record<string, unknown> & { gain?: number; env: Record<string, number>; filter?: Record<string, unknown> };
interface Recipe { gain: number; loop?: boolean; layers: Layer[] }
const recipes = (): Record<string, Recipe> => (JSON.parse(readFileSync(FILE, "utf8")) as { sounds: Record<string, Recipe> }).sounds;

// 6 KB since OME-1969's nine emote sounds (was 4 KB); it rides the lazy sound chunk, about 1 KB gzipped.
test("the recipe file is at most 6 KB", () => {
  expect(statSync(FILE).size).toBeLessThanOrEqual(6144);
});

test("it holds exactly the names the engine plays, in format v1", () => {
  const json = JSON.parse(readFileSync(FILE, "utf8")) as { version: unknown; sounds: object };
  expect(Object.keys(json)).toEqual(["version", "sounds"]);
  expect(json.version).toBe(1);
  expect(Object.keys(json.sounds).sort()).toEqual([...NAMES].sort());
});

test("only the fields of format v1", () => {
  const keys = { recipe: ["gain", "loop", "layers"], osc: ["osc", "freq", "to", "env", "gain", "filter"], noise: ["noise", "env", "gain", "filter"], env: ["a", "d", "s", "hold", "r", "delay"], filter: ["type", "freq", "q"] };
  const extra: string[] = [];
  const check = (where: string, o: object, allowed: string[]): void => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) extra.push(`${where}.${k}`);
  };
  for (const [name, r] of Object.entries(recipes())) {
    check(name, r, keys.recipe);
    for (const l of r.layers) {
      check(name, l, "osc" in l ? keys.osc : keys.noise);
      check(name, l.env, keys.env);
      if (l.filter !== undefined) check(name, l.filter, keys.filter);
    }
  }
  expect(extra).toEqual([]);
});

test("only room tones loop", () => {
  const loops = Object.entries(recipes()).filter(([, r]) => r.loop === true).map(([n]) => n);
  expect(loops.sort()).toEqual(["tone.cool", "tone.night", "tone.warm"]);
});

// A conservative bound: every layer that can sound at the same moment at its peak at once (a layer sounds from `delay` to
// the end of its envelope; a loop never ends). The audition page's meter (sound-meter.ts) measures the real peak.
const span = (l: Layer, loop: boolean): [number, number] => {
  const { delay = 0, a = 0, d = 0, hold = 0, r = 0 } = l.env;
  return [delay, loop ? Infinity : delay + a + d + hold + r];
};
const boundPeak = (r: Recipe): number => {
  const spans = r.layers.map((l) => ({ g: l.gain ?? 1, s: span(l, r.loop === true) }));
  return r.gain * Math.max(...spans.map(({ s: [t] }) => spans.filter(({ s: [a, b] }) => a <= t && t < b).reduce((sum, x) => sum + x.g, 0)));
};
test("the peak bound only adds layers that overlap in time", () => {
  const env = { a: 0.01, d: 0.04 };
  expect(boundPeak({ gain: 0.2, layers: [{ env }, { env: { ...env, delay: 0.1 } }] })).toBeCloseTo(0.2);
  expect(boundPeak({ gain: 0.2, layers: [{ env }, { env: { ...env, delay: 0.02 }, gain: 0.5 }] })).toBeCloseTo(0.3);
  expect(boundPeak({ gain: 0.2, loop: true, layers: [{ env }, { env: { ...env, delay: 0.1 } }] })).toBeCloseTo(0.4);
});
test("no sound can peak above -12 dBFS at full volume", () => {
  const over = Object.entries(recipes()).filter(([, r]) => boundPeak(r) > PEAK).map(([n]) => n);
  expect(over).toEqual([]);
});

test("0 bytes of audio files under assets/", () => {
  const audio: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name));
      else if (/\.(wav|mp3|ogg|oga|opus|flac|m4a|aac|weba|webm)$/i.test(e.name)) audio.push(e.name);
    }
  };
  walk(ASSETS);
  expect(audio).toEqual([]);
});
