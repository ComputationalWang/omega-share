// Two tabs of one browser in one room (OME-2429): the second one is refused for a name that is its own, in the first.
// The tabs tell each other over a BroadcastChannel named for the room. A local contract, not wire: it never leaves the
// browser. Still a boundary (any same-origin page can post to it), so every message is parsed and anything else dropped.
// `take` hands the first tab's session record over; resuming with it moves the member here (4007 there, ADR 0043).
import * as v from "valibot";
import { NicknameSchema, ResumeRecordSchema, type ResumeRecord } from "@omega/shared";

/** The part of `BroadcastChannel` we use. */
export interface TabChannel {
  onmessage: ((ev: MessageEvent) => void) | null;
  postMessage(data: unknown): void;
  close(): void;
}

const MessageSchema = v.variant("t", [
  v.strictObject({ t: v.literal("who"), nickname: NicknameSchema }),
  v.strictObject({ t: v.literal("here"), nickname: NicknameSchema }),
  v.strictObject({ t: v.literal("take"), nickname: NicknameSchema }),
  v.strictObject({ t: v.literal("record"), record: ResumeRecordSchema }),
]);

/** How long `take` waits for the other tab: it answers within a task unless it's gone. */
const TAKE_WAIT_MS = 500;

export interface TabPresenceOptions {
  readonly channel: TabChannel;
  /** The name this tab joins as. */
  readonly nickname: string;
  /** This tab's session while it is in the room, else null. */
  readonly here: () => ResumeRecord | null;
  /** Another tab answered: it is in the room under our name. */
  readonly onElsewhere: () => void;
  readonly setTimer: (fn: () => void, ms: number) => void;
}

export interface TabPresence {
  /** Ask the other tabs whether one of them is in the room under our name. */
  ask(): void;
  /** One did. */
  elsewhere(): boolean;
  /** Its session record, handed over; null if nobody answered in time. */
  take(): Promise<ResumeRecord | null>;
  close(): void;
}

export function createTabPresence(o: TabPresenceOptions): TabPresence {
  let seen = false;
  let waiting: ((r: ResumeRecord | null) => void) | null = null;
  const mine = (nickname: string): ResumeRecord | null => {
    const r = o.here();
    return r !== null && r.nickname === nickname ? r : null;
  };
  o.channel.onmessage = (ev) => {
    const parsed = v.safeParse(MessageSchema, ev.data);
    if (!parsed.success) return;
    const m = parsed.output;
    if (m.t === "who") {
      if (mine(m.nickname) !== null) o.channel.postMessage({ t: "here", nickname: m.nickname });
    } else if (m.t === "here") {
      if (m.nickname !== o.nickname) return;
      seen = true;
      o.onElsewhere();
    } else if (m.t === "take") {
      const r = mine(m.nickname);
      if (r !== null) o.channel.postMessage({ t: "record", record: r });
    } else if (m.record.nickname === o.nickname) {
      waiting?.(m.record);
      waiting = null;
    }
  };
  return {
    ask: () => {
      o.channel.postMessage({ t: "who", nickname: o.nickname });
    },
    elsewhere: () => seen,
    take: () =>
      new Promise((resolve) => {
        waiting = resolve;
        o.setTimer(() => {
          if (waiting !== resolve) return;
          waiting = null;
          resolve(null);
        }, TAKE_WAIT_MS);
        o.channel.postMessage({ t: "take", nickname: o.nickname });
      }),
    close: () => {
      o.channel.close();
    },
  };
}
