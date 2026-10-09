import type { TwitchOptions } from "../../src/tv";

export type TwitchCall = [name: string, ...args: unknown[]];

/** The part of an iframe the post-render check reads. */
export interface FakeIframe {
  readonly tagName: string;
  /** Stands in for the frame's window: the `source` of its postMessages. */
  readonly contentWindow: object | null;
  getAttribute(name: string): string | null;
}

/** A container the SDK renders into: the adapter only reads `children` and calls `replaceChildren()`. */
export class FakeContainer {
  children: FakeIframe[] = [];
  appendChild(c: FakeIframe): void {
    this.children.push(c);
  }
  replaceChildren(): void {
    this.children = [];
  }
  asElement(): HTMLElement {
    return this as unknown as HTMLElement;
  }
}

/** Builds the iframe src the way the real SDK does: options + parent + referrer as query parameters. */
export function sdkSrc(options: TwitchOptions, extra: Record<string, string> = {}): string {
  const q = new URLSearchParams();
  for (const [k, val] of Object.entries(options)) {
    if (Array.isArray(val)) for (const x of val) q.append(k, String(x));
    else q.append(k, String(val));
  }
  q.append("referrer", "https://room.example/r/lobby");
  for (const [k, val] of Object.entries(extra)) q.set(k, val);
  return `https://player.twitch.tv?${q.toString()}`;
}

/**
 * Minimal in-memory Twitch.Player for adapter unit tests. The read-outs are the SDK's cached
 * state (tests set them, as the iframe's UPDATE_STATE pushes would); `fire()` sends an event.
 */
export class FakeTwitchPlayer {
  readonly calls: TwitchCall[] = [];
  readonly listeners = new Map<string, ((p?: unknown) => void)[]>();
  currentTime: unknown = 0;
  duration: unknown = 0;
  playback: unknown = "Idle";
  paused: unknown = true;
  ended: unknown = false;
  /** false = the player has no getPlayerState() (older SDK). */
  hasPlayerState = true;
  /** `getQualities()`: the SDK's cached list, objects like `{ name: "720p60", group: "720p60" }`. */
  qualities: unknown = [];
  /** `getQuality()`: the group of the quality playing. */
  quality: unknown = "auto";

  constructor(
    readonly target: unknown,
    readonly options: TwitchOptions,
  ) {}

  fire(name: string, params?: unknown): void {
    for (const cb of [...(this.listeners.get(name) ?? [])]) cb(params);
  }
  listenerCount(): number {
    let n = 0;
    for (const l of this.listeners.values()) n += l.length;
    return n;
  }

  play(): void {
    this.calls.push(["play"]);
  }
  pause(): void {
    this.calls.push(["pause"]);
  }
  seek(s: number): void {
    this.calls.push(["seek", s]);
  }
  setMuted(m: boolean): void {
    this.calls.push(["setMuted", m]);
  }
  setVolume(v: number): void {
    this.calls.push(["setVolume", v]);
  }
  getCurrentTime(): unknown {
    return this.currentTime;
  }
  getDuration(): unknown {
    return this.duration;
  }
  isPaused(): unknown {
    return this.paused;
  }
  getEnded(): unknown {
    return this.ended;
  }
  getQualities(): unknown {
    return this.qualities;
  }
  getQuality(): unknown {
    return this.quality;
  }
  setQuality(q: string): void {
    this.calls.push(["setQuality", q]);
    this.quality = q;
  }
  addEventListener(name: string, cb: (p?: unknown) => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), cb]);
  }
  removeEventListener(name: string, cb: (p?: unknown) => void): void {
    this.listeners.set(
      name,
      (this.listeners.get(name) ?? []).filter((f) => f !== cb),
    );
  }
}

export interface FakeTwitchOptions {
  /** What the SDK appends to the container; default: one iframe built like the real SDK's. */
  render?: (options: TwitchOptions) => FakeIframe[];
}

/** `window.Twitch` with a Player that records every instance and renders an iframe into the target. */
export function fakeTwitch(o: FakeTwitchOptions = {}): { twitch: { Player: unknown }; players: FakeTwitchPlayer[] } {
  const players: FakeTwitchPlayer[] = [];
  const render = o.render ?? ((opts: TwitchOptions) => [iframe(sdkSrc(opts))]);
  class Player extends FakeTwitchPlayer {
    constructor(target: unknown, options: TwitchOptions) {
      super(target, options);
      if (target instanceof FakeContainer) for (const f of render(options)) target.appendChild(f);
      players.push(this);
    }
    getPlayerState(): unknown {
      return this.hasPlayerState ? { playback: this.playback, currentTime: this.currentTime } : undefined;
    }
  }
  return { twitch: { Player }, players };
}

export function iframe(src: string, tagName = "IFRAME", contentWindow: object | null = {}): FakeIframe {
  return { tagName, contentWindow, getAttribute: (n) => (n === "src" ? src : null) };
}
