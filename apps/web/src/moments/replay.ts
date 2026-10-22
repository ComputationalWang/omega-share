import type { EmoteKind, MemberId, Reaction } from "@omega/shared";

export const ARRIVAL_MAX = 8;

export interface ReplayOptions<Timer> {
  readonly position: () => { readonly ms: number; readonly rate: number } | null;
  readonly show: (id: MemberId, kind: EmoteKind) => void;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
}

export interface Replay {
  start(reactions: readonly Reaction[]): void;
  push(r: Reaction): void;
  sync(): void;
  stop(): void;
}

export function createReplay<Timer>(_o: ReplayOptions<Timer>): Replay {
  throw new Error("not implemented");
}
