import {
  QUEUE_ADD_MEMBER_BURST,
  QUEUE_ADD_MEMBER_REFILL_MS,
  QUEUE_ADD_ROOM_BURST,
  QUEUE_ADD_ROOM_REFILL_MS,
  QUEUE_ENDED_DEBOUNCE_MS,
  QUEUE_ENDED_TOLERANCE_S,
  QUEUE_MAX,
  isSyncedEmbed,
  playbackCaps,
  type MemberId,
  type QueueItem,
  type QueueItemId,
  type ServerMessage,
} from "@omega/shared";
import type { EmbedPolicy } from "./embed-policy";
import { logError } from "./log";
import { expectedPosition } from "./playback";
import { TokenBucket, type Clock } from "./rate-limit";
import { newItemId, type Room } from "./room";
import type { RoomRegistry } from "./rooms";
import type { RoomStore } from "./store/rooms";

/** The store writes a queue action makes: one each (ADR 0031 §6). */
export type QueuePersistence = Pick<RoomStore, "addQueueItem" | "removeQueueItem" | "advanceQueue">;

/** Who is changing the queue: the member, whether they joined as owner, and their add bucket. */
export interface QueueActor {
  memberId: MemberId;
  owner: boolean;
  /** Per member, shared by the WebSocket `queue-add` and `POST /rooms/:id/queue` (ADR 0031 §2). */
  addBucket: TokenBucket;
}

/** Why `admit`, `remove` or `advance` refused: the control policy, or an add bucket. */
export type QueueRefusal = { code: "control_owner_only" } | { code: "rate_limited"; retryAfterMs: number };

/** Why `add` refused an admitted URL. */
export type QueueAddRefusal =
  | { code: "unsupported_url" }
  | { code: "queue_full" }
  /** The store write failed: nothing changed, and the adds were given back. */
  | { code: "unavailable" };

export interface QueueDeps {
  rooms: RoomRegistry;
  embeds: EmbedPolicy;
  publish: (topic: string, data: string) => void;
  /** Absent: the queue lives in memory only. */
  store: QueuePersistence | null;
  /** Monotonic clock for the add buckets and the `ended` debounce. */
  now: Clock;
}

export interface Queue {
  /** A fresh per-member add bucket, for a joining member. */
  memberBucket: () => TokenBucket;
  /**
   * A `queue-add`'s checks before the URL is looked at (ADR 0031 §3): control policy, then the member's
   * bucket, then the room's. Null when they pass (the buckets are spent), else why not.
   */
  admit: (room: Room, actor: QueueActor) => QueueRefusal | null;
  /** After `admit`: parses `url` with the share parser, checks QUEUE_MAX, stores, then tells the room. */
  add: (room: Room, actor: QueueActor, url: string) => QueueItem | QueueAddRefusal;
  /** `queue-remove`: refused under the owner policy; an item that isn't there is ignored (null). */
  remove: (room: Room, actor: QueueActor, itemId: QueueItemId) => QueueRefusal | null;
  /** `queue-advance`: refused under the owner policy; ignored (null) unless `fromItemId` is current. */
  advance: (room: Room, actor: QueueActor, fromItemId: QueueItemId) => QueueRefusal | null;
  /** `ended` from a joined member: advances on the first valid report (ADR 0031 §4), else nothing. */
  ended: (room: Room, itemId: QueueItemId, position: number) => void;
}

const encode = (msg: ServerMessage): string => JSON.stringify(msg);

/** The playback queue (ADR 0031): the checks, the store-first writes and the frames, for ws.ts and http.ts alike. */
export function createQueue({ rooms, embeds, publish, store, now }: QueueDeps): Queue {
  // Dropped with the room (RoomRegistry.removeRoom).
  const roomAdds = rooms.perRoom(() => new TokenBucket(QUEUE_ADD_ROOM_BURST, 1000 / QUEUE_ADD_ROOM_REFILL_MS, now));

  const ownerOnly = (room: Room, actor: QueueActor): QueueRefusal | null =>
    room.controlPolicy === "owner" && !actor.owner ? { code: "control_owner_only" } : null;

  /** Store first: if the write fails nothing changes, so memory never runs ahead of the DB. */
  const persisted = (write: (s: QueuePersistence) => void): boolean => {
    if (store === null) return true;
    try {
      write(store);
      return true;
    } catch (err) {
      logError("store.queue", err);
      return false;
    }
  };

  const queueChanged = (room: Room, by: MemberId | null): void => {
    publish(room.topic, encode({ type: "queue-changed", queue: [...room.queue], by }));
  };

  /** One synchronous step (ADR 0031 §5): store, then memory, then embed-changed (the spread's critical path) and queue-changed. */
  const advanceNow = (room: Room, by: MemberId | null): void => {
    const next = room.queue[0];
    if (next === undefined) return;
    if (!persisted((s) => {
      s.advanceQueue(room.id, { id: next.id, embed: next.embed });
    })) return;
    const advanced = room.advance(now());
    if (advanced === null) return;
    const { item, embedSwitch } = advanced;
    publish(room.topic, encode({ type: "embed-changed", embed: item.embed, by: null, playback: embedSwitch.playback, itemId: item.id }));
    queueChanged(room, by);
    for (const memberId of embedSwitch.uncaught) publish(room.topic, encode({ type: "member-status", memberId, catching: false }));
  };

  return {
    memberBucket: () => new TokenBucket(QUEUE_ADD_MEMBER_BURST, 1000 / QUEUE_ADD_MEMBER_REFILL_MS, now),

    admit(room, actor) {
      const refused = ownerOnly(room, actor);
      if (refused !== null) return refused;
      if (!actor.addBucket.take()) return { code: "rate_limited", retryAfterMs: actor.addBucket.retryAfterMs() };
      const roomBucket = roomAdds.get(room);
      if (!roomBucket.take()) {
        // The room's limit is everyone's: the member keeps their own add.
        actor.addBucket.refund();
        return { code: "rate_limited", retryAfterMs: roomBucket.retryAfterMs() };
      }
      return null;
    },

    add(room, actor, url) {
      // Only the parsed embed is ever stored or relayed (ADR 0031 §2, ADR 0024).
      const embed = embeds.accept(url);
      if (embed === null) return { code: "unsupported_url" };
      // Refuse, never evict.
      if (room.queue.length >= QUEUE_MAX) return { code: "queue_full" };
      const item: QueueItem = { id: newItemId(), embed, by: actor.memberId };
      if (!persisted((s) => {
        s.addQueueItem(room.id, { id: item.id, embed });
      })) {
        // The server's failure, not the member's: they keep their adds.
        actor.addBucket.refund();
        roomAdds.get(room).refund();
        return { code: "unavailable" };
      }
      room.enqueue(item);
      queueChanged(room, actor.memberId);
      return item;
    },

    remove(room, actor, itemId) {
      const refused = ownerOnly(room, actor);
      if (refused !== null) return refused;
      // Removed already, or advanced: a race, not a mistake.
      if (!room.queue.some((i) => i.id === itemId)) return null;
      if (!persisted((s) => {
        s.removeQueueItem(room.id, itemId);
      })) return null;
      room.dequeue(itemId);
      queueChanged(room, actor.memberId);
      return null;
    },

    advance(room, actor, fromItemId) {
      const refused = ownerOnly(room, actor);
      if (refused !== null) return refused;
      // Two clicks from the same item skip one item: the second names what is no longer current.
      if (fromItemId === room.itemId) advanceNow(room, actor.memberId);
      return null;
    },

    ended(room, itemId, position) {
      if (itemId !== room.itemId) return;
      // Live embeds never end and generic ones have no API: they advance by queue-advance only.
      const embed = room.currentEmbed;
      if (embed === null || !isSyncedEmbed(embed) || playbackCaps(embed).live) return;
      if (now() - room.itemSince < QUEUE_ENDED_DEBOUNCE_MS) return;
      const playback = room.currentPlayback;
      if (playback === null) return;
      // Drops reports from before a seek, and local-only seeks (R1 B3).
      if (Math.abs(position - expectedPosition(playback, Date.now())) > QUEUE_ENDED_TOLERANCE_S) return;
      advanceNow(room, null);
    },
  };
}
