// The pop-out chat's channel (OME-598, M7 W3, R-M7a Q3 a): the room tab and its pop-out window talk over a
// BroadcastChannel named for the room and the tab. A local contract, not wire: it never leaves the browser, so it lives
// here and not in packages/shared. It is still a boundary (any same-origin page can post to the channel), so every
// message is parsed on receipt and anything else is dropped. Room tab → window: `room-*`; window → room tab: `pop-*`.
import * as v from "valibot";
import { EmoteKindSchema, RoomIdSchema, type RoomId } from "@omega/shared";
import type { ChatLogEntry } from "../chat/log";
import type { SyslineGlyph } from "../controls/sysline";
import { CHAT_LOG_CAP } from "../chat/log";

const GLYPHS = ["play", "pause", "seek", "remote", "chat-mute", "host"] as const satisfies readonly SyslineGlyph[];
/** Longer than any line we make (a chat is ≤ 280, a nickname ≤ 20); a cap on what a stray poster can make us draw. */
const Text = v.pipe(v.string(), v.maxLength(1000));
/** A pop-out's id (random per window load) and a tab's id: short, plain. */
const IdSchema = v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,40}$/i));
const Seq = v.pipe(v.number(), v.integer(), v.minValue(0));

const SystemLineSchema = v.strictObject({
  glyph: v.picklist(GLYPHS),
  actor: v.nullable(Text),
  verb: Text,
  time: v.nullable(Text),
  self: v.exactOptional(v.boolean()),
});

// Typed as the log's entry: a change to one that the other can't carry fails the build here.
const ChatLogEntrySchema: v.GenericSchema<ChatLogEntry> = v.variant("kind", [
  v.strictObject({ kind: v.literal("chat"), nickname: Text, text: Text, self: v.boolean() }),
  v.strictObject({ kind: v.literal("system"), line: SystemLineSchema }),
]);

/** What the window needs from the room's state: the head count, and whether (and why not) it may send. */
const PopStateFields = {
  title: v.nullable(Text),
  people: Seq,
  cap: Seq,
  /** The chat row is up in the room (joined, not removed or closed). */
  open: v.boolean(),
  cooling: v.boolean(),
  muted: v.boolean(),
  placeholder: Text,
};

const PopMessageSchema = v.variant("t", [
  /** The room tab started (or reloaded): an open window says it's ready again. */
  v.strictObject({ t: v.literal("room-hello") }),
  /** This window (by id) is the tab's pop-out; any other closes. */
  v.strictObject({ t: v.literal("room-adopt"), pop: IdSchema }),
  v.strictObject({ t: v.literal("room-log"), reset: v.boolean(), entries: v.pipe(v.array(ChatLogEntrySchema), v.maxLength(CHAT_LOG_CAP)) }),
  v.strictObject({ t: v.literal("room-state"), ...PopStateFields }),
  /** The answer to a pop-say / pop-emote: sent on the socket or not. */
  v.strictObject({ t: v.literal("room-said"), pop: IdSchema, seq: Seq, ok: v.boolean() }),
  /** Chat was brought back into the page: close. */
  v.strictObject({ t: v.literal("room-back") }),
  /** The room tab is going away (closed, reloaded, navigated). */
  v.strictObject({ t: v.literal("room-gone") }),
  v.strictObject({ t: v.literal("pop-ready"), pop: IdSchema }),
  v.strictObject({ t: v.literal("pop-ping"), pop: IdSchema }),
  v.strictObject({ t: v.literal("pop-say"), pop: IdSchema, seq: Seq, text: Text }),
  v.strictObject({ t: v.literal("pop-emote"), pop: IdSchema, seq: Seq, kind: EmoteKindSchema }),
  /** The window's put-back key. */
  v.strictObject({ t: v.literal("pop-back"), pop: IdSchema }),
  /** The window is closing (pagehide). */
  v.strictObject({ t: v.literal("pop-bye"), pop: IdSchema }),
]);

export type PopMessage = v.InferOutput<typeof PopMessageSchema>;
export type PopState = Omit<Extract<PopMessage, { t: "room-state" }>, "t">;

export function parsePopMessage(data: unknown): PopMessage | null {
  const r = v.safeParse(PopMessageSchema, data);
  return r.success ? r.output : null;
}

/** The two ends' view of the channel; `browserChannel` is the real one, tests pass their own. */
export interface PopChannel {
  post(m: PopMessage): void;
  /** Raw data as it arrived; the caller parses it. */
  onMessage(fn: (data: unknown) => void): void;
  close(): void;
}

export const channelName = (roomId: RoomId, tab: string): string => `omega-chat:${roomId}:${tab}`;

export function browserChannel(name: string): PopChannel {
  const ch = new BroadcastChannel(name);
  return {
    post: (m) => {
      ch.postMessage(m);
    },
    onMessage: (fn) => {
      ch.onmessage = (ev: MessageEvent<unknown>) => {
        fn(ev.data);
      };
    },
    close: () => {
      ch.close();
    },
  };
}

/** Set k: the pop-out is desktop only, and needs BroadcastChannel (the window has no other way to reach the room tab). */
export function popoutSupported(o: { readonly hasChannel: boolean; readonly phone: boolean }): boolean {
  return o.hasChannel && !o.phone;
}

/** The window's address: the room and the tab ride in the hash (never sent to the server; no secret in either). */
export function popoutUrl(roomId: RoomId, tab: string): string {
  return `/chat.html#r=${roomId}&t=${tab}`;
}

export function readPopoutHash(hash: string): { roomId: RoomId; tab: string } | null {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const room = v.safeParse(RoomIdSchema, p.get("r"));
  const tab = v.safeParse(IdSchema, p.get("t"));
  return room.success && tab.success ? { roomId: room.output, tab: tab.output } : null;
}

/** A short random id: a tab's (kept in sessionStorage, so a reload keeps it) or a window load's. */
export function randomId(prefix: string): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return `${prefix}-${Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")}`;
}
