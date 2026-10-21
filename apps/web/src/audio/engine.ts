// The procedural sound engine (OME-1638). Plays recipes (recipes.ts) on one WebAudio context, made only by `unlock` (the
// Enter-room gesture), through one master gain at the user's volume (this device's, in localStorage, never on the wire).
// At most 4 voices sound at once: a nearer sound takes the farthest one's place, a farther one is dropped. Footfalls and
// sit/stand come from the poses the animator already draws (`pose`), so the engine has no timers of its own. It only
// makes sound: it never touches a provider's player or its volume.
import type { MemberId } from "@omega/shared";
import type { Point } from "../layout";
import type { Pose } from "../walk/walks";
import type { FloorKind } from "./floor";
import type { Env, Layer, Recipe, Recipes } from "./recipes";

export const SOUND_VOLUME_KEY = "omega.sound.volume";
export const SOUND_MUTED_KEY = "omega.sound.muted";
/** On by default, at a modest level. */
export const DEFAULT_VOLUME = 0.4;
export const MAX_VOICES = 4;
/** A stolen voice or a stopped tone fades this fast (s), so it doesn't click. */
const CUT_S = 0.015;
/** An attack of 0 still ramps over this (s), for the same reason. */
const MIN_ATTACK_S = 0.002;
const NOISE_S = 2;

interface ParamLike {
  value: number;
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  exponentialRampToValueAtTime(v: number, t: number): unknown;
  cancelScheduledValues(t: number): unknown;
}
interface NodeLike {
  connect(to: NodeLike): unknown;
  disconnect(): unknown;
}
interface SourceLike extends NodeLike {
  start(at: number): unknown;
  stop(at: number): unknown;
}
interface BufferLike {
  getChannelData(channel: number): Float32Array;
}

/** The part of an AudioContext the engine uses; tests pass a fake. */
export interface AudioCtx {
  readonly currentTime: number;
  readonly state: AudioContextState;
  readonly sampleRate: number;
  readonly destination: NodeLike;
  resume(): Promise<void>;
  close?(): Promise<void>;
  createGain(): NodeLike & { gain: ParamLike };
  createBiquadFilter(): NodeLike & { type: BiquadFilterType; frequency: ParamLike; Q: ParamLike };
  createOscillator(): SourceLike & { type: OscillatorType; frequency: ParamLike };
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferSource(): SourceLike & { buffer: BufferLike | null; loop: boolean };
}

interface BakedBuffer extends BufferLike {
  readonly duration: number;
}

/** The part of an OfflineAudioContext the engine uses to bake a one-shot into a buffer. */
export interface OfflineCtx extends AudioCtx {
  startRendering(): Promise<BakedBuffer>;
}

/** A `localStorage`-like store; its methods may throw (blocked storage). */
export interface SoundStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SoundOptions {
  readonly makeContext: () => AudioCtx;
  /**
   * Bakes each one-shot once after unlock (mono, `length` frames), so a footfall then costs one buffer source and a
   * gain on the main thread, not a node graph per layer. Without it, every play synthesizes live.
   */
  readonly makeOffline?: (length: number, sampleRate: number) => OfflineCtx;
  readonly recipes: Recipes;
  readonly store: SoundStore;
  /** Where I am in the room (the stage point of my avatar), null before I'm placed. */
  readonly listener: () => Point | null;
  /** The floor under a stage point. */
  readonly floorAt: (p: Point) => FloorKind;
}

export interface Sound {
  /** A user gesture: makes the context the first time, resumes it if the browser suspended it. */
  unlock(): void;
  /** Plays `name` once, `distance` stage px from me (0: UI, always among the nearest). Missing names are silent. */
  play(name: string, distance?: number): void;
  /** `id` was drawn at `p`: a footfall on each half of the walk cycle, a creak on sitting down or getting up. */
  pose(id: MemberId, p: Pose): void;
  /** The room's mood: loops `tone.<mood>` until the mood changes. */
  tone(mood: string): void;
  volume(): number;
  setVolume(v: number): void;
  muted(): boolean;
  setMuted(m: boolean): void;
  dispose(): void;
}

interface Voice {
  readonly name: string;
  /** When it started (context time): walkers step together on the shared clock, so a footfall at an instant plays once. */
  readonly at: number;
  readonly distance: number;
  end: number;
  readonly cut: (at: number) => void;
}

function read(store: SoundStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
function write(store: SoundStore, key: string, value: string): void {
  try {
    store.setItem(key, value);
  } catch {
    // Storage off (private mode): the choice lasts for this page only.
  }
}

/** localStorage is untrusted: a volume is a number in 0..1, anything else the default. */
function storedVolume(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_VOLUME;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : DEFAULT_VOLUME;
}

function fillNoise(kind: "white" | "pink" | "brown", data: Float32Array): void {
  let b0 = 0, b1 = 0, b2 = 0, last = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") data[i] = w;
    else if (kind === "pink") {
      // Paul Kellet's economy pink filter.
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = (b0 + b1 + b2 + w * 0.1848) * 0.25;
    } else {
      last = (last + 0.02 * w) / 1.02;
      data[i] = last * 3.5;
    }
  }
}

/** How long a one-shot layer lasts from its start (s). */
const layerLength = (e: Env): number => Math.max(MIN_ATTACK_S, e.a ?? 0) + (e.d ?? 0) + (e.hold ?? 0) + (e.r ?? 0);

export function createSound(o: SoundOptions): Sound {
  let ctx: AudioCtx | null = null;
  let master: (NodeLike & { gain: ParamLike }) | null = null;
  let broken = false;
  let volume = storedVolume(read(o.store, SOUND_VOLUME_KEY));
  let muted = read(o.store, SOUND_MUTED_KEY) === "on";
  let mood = "none";
  let toneVoice: Voice | null = null;
  const voices: Voice[] = [];
  const noise = new Map<string, BufferLike>();
  const baked = new Map<string, BakedBuffer>();
  // shortcut: one entry per member ever drawn in this room view (tens), dropped with the room; prune on leave if rooms grow.
  const seen = new Map<MemberId, { walking: boolean; half: number; sitting: boolean }>();

  const level = (): number => (muted ? 0 : volume);

  function noiseBuffer(c: AudioCtx, kind: "white" | "pink" | "brown"): BufferLike {
    let b = noise.get(kind);
    if (b === undefined) {
      const length = Math.round(c.sampleRate * NOISE_S);
      b = c.createBuffer(1, length, c.sampleRate);
      fillNoise(kind, b.getChannelData(0));
      noise.set(kind, b);
    }
    return b;
  }

  /** Starts `r` now; a loop holds at its sustain until cut. A tone is never stolen (distance -Infinity). */
  function start(c: AudioCtx, out: NodeLike, name: string, r: Recipe, loop: boolean, distance: number): Voice {
    const now = c.currentTime;
    const bus = c.createGain();
    bus.gain.value = r.gain;
    bus.connect(out);
    const sources: SourceLike[] = [];
    let end = now;
    for (const l of r.layers) {
      const e = l.env;
      const t0 = now + (e.delay ?? 0);
      const src = source(c, l, t0, loop);
      const g = c.createGain();
      const peak = l.gain ?? 1;
      const a = Math.max(MIN_ATTACK_S, e.a ?? 0);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + a);
      if (loop) {
        g.gain.linearRampToValueAtTime(peak * (e.s ?? 1), t0 + a + (e.d ?? 0));
      } else {
        const sustain = peak * (e.s ?? 0);
        g.gain.linearRampToValueAtTime(sustain, t0 + a + (e.d ?? 0));
        g.gain.setValueAtTime(sustain, t0 + a + (e.d ?? 0) + (e.hold ?? 0));
        g.gain.linearRampToValueAtTime(0, t0 + layerLength(e));
      }
      let tail: NodeLike = src;
      if (l.filter !== undefined) {
        const f = c.createBiquadFilter();
        f.type = l.filter.type;
        f.frequency.value = l.filter.freq;
        f.Q.value = l.filter.q ?? 1;
        tail.connect(f);
        tail = f;
      }
      tail.connect(g);
      g.connect(bus);
      src.start(t0);
      if (!loop) src.stop(t0 + layerLength(e));
      sources.push(src);
      end = Math.max(end, t0 + layerLength(e));
    }
    const release = Math.max(CUT_S, ...r.layers.map((l) => (loop ? (l.env.r ?? 0) : 0)));
    return {
      name,
      at: now,
      distance,
      end: loop ? Infinity : end,
      cut(at) {
        bus.gain.cancelScheduledValues(at);
        bus.gain.setValueAtTime(bus.gain.value, at);
        bus.gain.linearRampToValueAtTime(0, at + release);
        for (const s of sources) s.stop(at + release);
        this.end = at + release;
      },
    };
  }

  function source(c: AudioCtx, l: Layer, t0: number, loop: boolean): SourceLike {
    if ("osc" in l) {
      const osc = c.createOscillator();
      osc.type = l.osc;
      osc.frequency.value = l.freq;
      osc.frequency.setValueAtTime(l.freq, t0);
      if (l.to !== undefined && !loop) osc.frequency.exponentialRampToValueAtTime(l.to, t0 + layerLength(l.env));
      return osc;
    }
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, l.noise);
    src.loop = true;
    return src;
  }

  function startBaked(c: AudioCtx, out: NodeLike, name: string, b: BakedBuffer, distance: number): Voice {
    const now = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = b;
    const g = c.createGain();
    src.connect(g);
    g.connect(out);
    src.start(now);
    return {
      name,
      at: now,
      distance,
      end: now + b.duration,
      cut(at) {
        g.gain.setValueAtTime(g.gain.value, at);
        g.gain.linearRampToValueAtTime(0, at + CUT_S);
        src.stop(at + CUT_S);
        this.end = at + CUT_S;
      },
    };
  }

  function bakeAll(sampleRate: number): void {
    const make = o.makeOffline;
    if (make === undefined) return;
    for (const [name, r] of Object.entries(o.recipes.sounds)) {
      if (r.loop === true) continue;
      const seconds = Math.max(...r.layers.map((l) => (l.env.delay ?? 0) + layerLength(l.env)));
      try {
        const off = make(Math.ceil((seconds + CUT_S) * sampleRate), sampleRate);
        start(off, off.destination, name, r, false, 0);
        off.startRendering().then(
          (b) => {
            baked.set(name, b);
          },
          () => undefined,
        );
      } catch {
        // No offline rendering here: this sound stays live.
      }
    }
  }

  function startTone(): void {
    const r = o.recipes.sounds[`tone.${mood}`];
    if (ctx === null || master === null || muted || r === undefined || toneVoice !== null) return;
    toneVoice = start(ctx, master, `tone.${mood}`, r, true, -Infinity);
    voices.push(toneVoice);
  }
  function stopTone(): void {
    if (toneVoice === null || ctx === null) return;
    toneVoice.cut(ctx.currentTime);
    toneVoice = null;
  }

  function play(name: string, distance = 0): void {
    if (ctx === null || master === null || muted) return;
    const r = o.recipes.sounds[name];
    if (r === undefined) return;
    const now = ctx.currentTime;
    for (let i = voices.length - 1; i >= 0; i--) {
      const v = voices[i];
      if (v === undefined || v.end <= now) voices.splice(i, 1);
      else if (v.at === now && v.name === name) return;
    }
    if (voices.length >= MAX_VOICES) {
      let far = -1;
      for (let i = 0; i < voices.length; i++) if (far < 0 || (voices[i]?.distance ?? 0) > (voices[far]?.distance ?? 0)) far = i;
      const v = voices[far];
      if (v === undefined || v.distance <= distance) return;
      v.cut(now);
      voices.splice(far, 1);
    }
    const b = baked.get(name);
    voices.push(b === undefined ? start(ctx, master, name, r, false, distance) : startBaked(ctx, master, name, b, distance));
  }

  return {
    unlock() {
      if (broken) return;
      if (ctx !== null) {
        if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
        return;
      }
      try {
        ctx = o.makeContext();
      } catch {
        // No WebAudio here: the room stays silent.
        broken = true;
        return;
      }
      master = ctx.createGain();
      master.gain.value = level();
      master.connect(ctx.destination);
      startTone();
      bakeAll(ctx.sampleRate);
    },
    play,
    pose(id, p) {
      const half = p.step >> 2;
      const s = seen.get(id);
      if (s === undefined) {
        seen.set(id, { walking: p.walking, half, sitting: p.sitting });
        return;
      }
      let name: string | null = null;
      if (p.walking && (!s.walking || half !== s.half)) name = `step.${o.floorAt(p)}`;
      else if (p.sitting && !s.sitting) name = "chair.sit";
      else if (!p.sitting && s.sitting) name = "chair.stand";
      s.walking = p.walking;
      s.half = half;
      s.sitting = p.sitting;
      if (name === null || ctx === null || muted) return;
      const me = o.listener();
      play(name, me === null ? 0 : Math.hypot(p.x - me.x, p.y - me.y));
    },
    tone(m) {
      if (m === mood) return;
      stopTone();
      mood = m;
      startTone();
    },
    volume: () => volume,
    setVolume(v) {
      volume = Math.min(1, Math.max(0, v));
      write(o.store, SOUND_VOLUME_KEY, String(volume));
      if (master !== null) master.gain.value = level();
    },
    muted: () => muted,
    setMuted(m) {
      muted = m;
      write(o.store, SOUND_MUTED_KEY, m ? "on" : "off");
      if (master !== null) master.gain.value = level();
      if (m) stopTone();
      else startTone();
    },
    dispose() {
      stopTone();
      void ctx?.close?.().catch(() => undefined);
      ctx = null;
      master = null;
      broken = true;
    },
  };
}
