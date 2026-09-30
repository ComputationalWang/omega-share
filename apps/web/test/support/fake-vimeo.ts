import type { VimeoNamespace, VimeoPlayer } from "../../src/player/vimeo-types";

export type VimeoCall = [name: string, ...args: unknown[]];

/** A promise the test settles by hand, like a postMessage reply that hasn't arrived yet. */
export interface Pending<T> {
  readonly promise: Promise<T>;
  resolve(v: T): void;
  reject(e: unknown): void;
}

export function pending<T>(): Pending<T> {
  let resolve: (v: T) => void = () => undefined;
  let reject: (e: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** An Error with the `name` the SDK gives a rejected method (`PrivacyError`, `PasswordError`, …). */
export function named(name: string): Error {
  const e = new Error(name);
  e.name = name;
  return e;
}

/**
 * Minimal in-memory `Vimeo.Player` for adapter unit tests. `ready()` and each `setPlaybackRate()`/`play()`
 * stay pending until the test settles them; every other method resolves at once. `fire()` delivers an event.
 */
export class FakeVimeoPlayer implements VimeoPlayer {
  readonly calls: VimeoCall[] = [];
  readonly readyP = pending<void>();
  readonly rateP: Pending<unknown>[] = [];
  readonly playP: Pending<void>[] = [];
  readonly handlers = new Map<string, Set<(data?: unknown) => void>>();
  videoId: unknown = 76979871;
  duration: unknown = 300;

  constructor(
    readonly el: unknown,
    readonly extraArgs: number,
  ) {}

  fire(event: string, data?: unknown): void {
    for (const h of this.handlers.get(event) ?? []) h(data);
  }
  listenerCount(): number {
    let n = 0;
    for (const s of this.handlers.values()) n += s.size;
    return n;
  }

  ready(): Promise<void> {
    return this.readyP.promise;
  }
  play(): Promise<void> {
    this.calls.push(["play"]);
    const p = pending<void>();
    this.playP.push(p);
    return p.promise;
  }
  pause(): Promise<void> {
    this.calls.push(["pause"]);
    return Promise.resolve();
  }
  setCurrentTime(s: number): Promise<unknown> {
    this.calls.push(["setCurrentTime", s]);
    return Promise.resolve(s);
  }
  setPlaybackRate(r: number): Promise<unknown> {
    this.calls.push(["setPlaybackRate", r]);
    const p = pending<unknown>();
    this.rateP.push(p);
    return p.promise;
  }
  setVolume(v: number): Promise<unknown> {
    this.calls.push(["setVolume", v]);
    return Promise.resolve(v);
  }
  setMuted(m: boolean): Promise<unknown> {
    this.calls.push(["setMuted", m]);
    return Promise.resolve(m);
  }
  getVideoId(): Promise<unknown> {
    return Promise.resolve(this.videoId);
  }
  getDuration(): Promise<unknown> {
    return Promise.resolve(this.duration);
  }
  destroy(): Promise<void> {
    this.calls.push(["destroy"]);
    return Promise.resolve();
  }
  on(event: string, cb: (data?: unknown) => void): void {
    let s = this.handlers.get(event);
    if (s === undefined) this.handlers.set(event, (s = new Set()));
    s.add(cb);
  }
  off(event: string, cb?: (data?: unknown) => void): void {
    if (cb === undefined) this.handlers.delete(event);
    else this.handlers.get(event)?.delete(cb);
  }
}

export function fakeVimeo(): { vm: VimeoNamespace; players: FakeVimeoPlayer[] } {
  const players: FakeVimeoPlayer[] = [];
  class Player extends FakeVimeoPlayer {
    constructor(el: unknown, ...rest: unknown[]) {
      super(el, rest.length);
      players.push(this);
    }
  }
  return { vm: { Player }, players };
}

/** Lets queued promise callbacks (the adapter's `.then`s) run. */
export const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
