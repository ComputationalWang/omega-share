// "Catch me up" (OME-1628): the current item's stored reactions (the snapshot's `reactions`, then each live `reacted`)
// replayed through the emote path when the video reaches them, so a late joiner sees what the room felt at that moment.
// One timer, to the next reaction (or the next step of the arrival burst); nothing polls, nothing runs while paused.
// The emote path keeps its own cap (one sticker per member at a time, a static badge under reduced motion).
import type { EmoteKind, MemberId, Reaction, ReactionKind } from "@omega/shared";

/** A reaction glyph as the emote it replays as. */
export const REACTION_EMOTE: Readonly<Record<ReactionKind, EmoteKind>> = { heart: "heart", laugh: "laugh", wow: "exclaim", clap: "clap" };
/** On arrival, the reactions of the last this-many media ms play back quickly… */
export const ARRIVAL_WINDOW_MS = 30_000;
/** …at most this many (the latest), one every ARRIVAL_STEP_MS. */
export const ARRIVAL_MAX = 8;
export const ARRIVAL_STEP_MS = 150;
/** A reaction this close ahead of the position is due now. */
const DUE_MS = 500;

export interface ReplayOptions<Timer> {
  /** The room's position in the current item, media ms, and its rate; null while paused or with no item. */
  readonly position: () => { readonly ms: number; readonly rate: number } | null;
  readonly show: (id: MemberId, kind: EmoteKind) => void;
  readonly setTimeout: (fn: () => void, ms: number) => Timer;
  readonly clearTimeout: (t: Timer) => void;
}

export interface Replay {
  /** A snapshot: replace the list with its reactions and play the last ARRIVAL_WINDOW_MS quickly. */
  start(reactions: readonly Reaction[]): void;
  /** A live `reacted`: stored for a later seek back, not replayed now (it was just shown live). */
  push(r: Reaction): void;
  /** The room's playback changed (play, pause, seek, rate): reschedule from the new position. */
  sync(): void;
  /** The item changed or the room went away. */
  stop(): void;
}

export function createReplay<Timer>(o: ReplayOptions<Timer>): Replay {
  /** Sorted by mediaMs. */
  let list: Reaction[] = [];
  /** list[next] is the first reaction not yet played. */
  let next = 0;
  let burst: Reaction[] = [];
  let timer: Timer | null = null;

  const show = (r: Reaction): void => {
    o.show(r.memberId, REACTION_EMOTE[r.kind]);
  };
  const clear = (): void => {
    if (timer !== null) o.clearTimeout(timer);
    timer = null;
  };
  const firstAfter = (ms: number): number => {
    const i = list.findIndex((r) => r.mediaMs > ms);
    return i < 0 ? list.length : i;
  };
  /** Play what's due at `ms`. */
  const flush = (ms: number): void => {
    for (let r = list[next]; r !== undefined && r.mediaMs <= ms + DUE_MS; r = list[next]) {
      next++;
      show(r);
    }
  };
  const fire = (): void => {
    timer = null;
    const b = burst.shift();
    if (b !== undefined) show(b);
    schedule();
  };
  function schedule(): void {
    clear();
    // The burst goes first; a reaction that falls due meanwhile plays right after it.
    if (burst.length > 0) {
      timer = o.setTimeout(fire, ARRIVAL_STEP_MS);
      return;
    }
    const p = o.position();
    if (p === null || !(p.rate > 0)) return;
    flush(p.ms);
    const r = list[next];
    if (r !== undefined) timer = o.setTimeout(fire, (r.mediaMs - p.ms) / p.rate);
  }

  return {
    start(reactions) {
      this.stop();
      list = [...reactions].sort((a, b) => a.mediaMs - b.mediaMs);
      const p = o.position();
      if (p !== null) {
        next = firstAfter(p.ms);
        burst = list.slice(0, next).filter((r) => r.mediaMs > p.ms - ARRIVAL_WINDOW_MS).slice(-ARRIVAL_MAX);
      }
      schedule();
    },
    push(r) {
      const p = o.position();
      // Live (at the position): what was due plays first, then this one counts as played.
      const live = p !== null && r.mediaMs <= p.ms + DUE_MS;
      if (live) flush(p.ms);
      const i = firstAfter(r.mediaMs);
      list.splice(i, 0, r);
      if (live || i < next) next++;
      // Ahead of the position (the server's clock ran ahead of ours): it may be the new next.
      else if (i === next) schedule();
    },
    sync() {
      const p = o.position();
      if (p !== null) next = firstAfter(p.ms);
      schedule();
    },
    stop() {
      clear();
      list = [];
      burst = [];
      next = 0;
    },
  };
}
