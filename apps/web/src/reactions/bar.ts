// The reaction bar (OME-1631). Red stub.
import type { ClientMessage, ReactionKind } from "@omega/shared";
import type { EmoteBucket } from "../emote/emotes";

export interface ReactionBarOptions {
  readonly send: (m: ClientMessage) => boolean;
  readonly bucket: EmoteBucket;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => unknown;
  readonly clearTimer: (h: unknown) => void;
}

export interface ReactionBar {
  readonly root: HTMLElement;
  key(ev: KeyboardEvent): boolean;
  react(kind: ReactionKind): boolean;
}

export function createReactionBar(_o: ReactionBarOptions): ReactionBar {
  throw new Error("not implemented");
}
