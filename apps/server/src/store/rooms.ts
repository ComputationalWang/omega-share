import type { Database, Statement } from "bun:sqlite";
import * as v from "valibot";
import {
  AnyEmbedSchema,
  ControlPolicySchema,
  QueueItemIdSchema,
  RoomIdSchema,
  RoomLayoutSchema,
  RoomTitleSchema,
  RoomVisibilitySchema,
  SeatIndexSchema,
  type AnyEmbed,
  type ControlPolicy,
  type QueueItemId,
  type RoomId,
  type RoomLayout,
  type RoomVisibility,
  type SeatIndex,
} from "@omega/shared";
import { logError } from "../log";

export interface StoredRoom {
  id: RoomId;
  /** Empty for a seeded room that has none. */
  title: string;
  /** Unix ms. */
  createdAt: number;
  layout: RoomLayout;
  embed: AnyEmbed | null;
  /** Fixed at creation (ADR 0028 §4). */
  visibility: RoomVisibility;
  /** Seeded rooms: never collected, no owner (ADR 0028 §2). */
  pinned: boolean;
  /** SHA-256 of the owner token; null for a pinned room. */
  ownerHash: Uint8Array | null;
  /** SHA-256 of the invite key; private rooms only. */
  inviteHash: Uint8Array | null;
  /** Unix ms the room last became empty or occupied; null if nobody ever joined. */
  lastActiveAt: number | null;
  /** Who controls playback (ADR 0030 §4). */
  controlPolicy: ControlPolicy;
  /** The current embed's queue item id (ADR 0031 §1); null with no embed, or one stored before migration 0005. */
  itemId: QueueItemId | null;
  /** Upcoming items in play order. Rows that fail to parse are left out. */
  queue: StoredQueueItem[];
}

/** An upcoming queue item as stored: no `by` (ADR 0031 §6). */
export interface StoredQueueItem {
  id: QueueItemId;
  embed: AnyEmbed;
}

/** A seat held across a graceful restart (ADR 0032): the name only as SHA-256 of its nickname key. */
export interface SeatHold {
  roomId: RoomId;
  nameHash: Uint8Array;
  seat: SeatIndex;
}

/** What `createRoom` takes. Without the ADR 0028 fields it is a seed: pinned, public, ownerless. */
export interface NewRoom {
  id: string;
  title: string;
  createdAt: number;
  layout: RoomLayout;
  visibility?: RoomVisibility;
  pinned?: boolean;
  ownerHash?: Uint8Array | null;
  inviteHash?: Uint8Array | null;
}

const TitleSchema = v.union([v.literal(""), RoomTitleSchema]);
const UnixMsSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const HashSchema = v.nullable(v.pipe(v.instance(Uint8Array), v.check((h) => h.length === 32, "expected 32 bytes")));

/** The DB file is a boundary too (D4): hand edits, restores and old versions all pass this parse. */
const RowSchema = v.object({
  id: RoomIdSchema,
  title: TitleSchema,
  created_at: UnixMsSchema,
  layout: v.pipe(v.string(), v.parseJson(), RoomLayoutSchema),
  embed: v.nullable(v.pipe(v.string(), v.parseJson(), AnyEmbedSchema)),
  visibility: RoomVisibilitySchema,
  pinned: v.picklist([0, 1]),
  owner_hash: HashSchema,
  invite_hash: HashSchema,
  last_active_at: v.nullable(UnixMsSchema),
  control_policy: ControlPolicySchema,
  item_id: v.nullable(QueueItemIdSchema),
});

const NewRoomSchema = v.object({
  id: RoomIdSchema,
  title: TitleSchema,
  createdAt: UnixMsSchema,
  layout: RoomLayoutSchema,
  visibility: v.optional(RoomVisibilitySchema, "public"),
  pinned: v.optional(v.boolean(), true),
  ownerHash: v.optional(HashSchema, null),
  inviteHash: v.optional(HashSchema, null),
});

const NullableEmbedSchema = v.nullable(AnyEmbedSchema);

const QueueItemSchema = v.object({ id: QueueItemIdSchema, embed: AnyEmbedSchema });

const QueueRowSchema = v.object({
  room_id: RoomIdSchema,
  id: QueueItemIdSchema,
  embed: v.pipe(v.string(), v.parseJson(), AnyEmbedSchema),
});

const SeatHoldRowSchema = v.object({
  room_id: RoomIdSchema,
  name_hash: v.pipe(v.instance(Uint8Array), v.check((h) => h.length === 32, "expected 32 bytes")),
  seat: SeatIndexSchema,
});

type Row = Record<keyof v.InferInput<typeof RowSchema>, unknown>;

/**
 * Write-through persistence for rooms (research §2.4). Only the rare mutations land here (room
 * created, layout set, embed changed), never the relay path. Every value is parsed on write and
 * every row on read; a corrupt row throws, naming the room.
 */
export class RoomStore {
  readonly #list: Statement<Row, []>;
  readonly #insert: Statement<unknown, [string, string, number, string, string, number, Uint8Array | null, Uint8Array | null]>;
  readonly #delete: Statement<unknown, [string]>;
  readonly #setLayout: Statement<unknown, [string, string]>;
  readonly #setEmbed: Statement<unknown, [string | null, string | null, string]>;
  readonly #setTitle: Statement<unknown, [string, string]>;
  readonly #setPinned: Statement<unknown, [number, string]>;
  readonly #setLastActive: Statement<unknown, [number, string]>;
  readonly #setControlPolicy: Statement<unknown, [string, string]>;
  readonly #db: Database;
  readonly #listHolds: Statement<Record<keyof v.InferInput<typeof SeatHoldRowSchema>, unknown>, []>;
  readonly #insertHold: Statement<unknown, [string, Uint8Array, number]>;
  readonly #listQueue: Statement<Record<keyof v.InferInput<typeof QueueRowSchema>, unknown>, []>;
  readonly #insertQueueItem: Statement<unknown, [string, string, string, string]>;
  readonly #deleteQueueItem: Statement<unknown, [string, string]>;

  constructor(db: Database) {
    this.#db = db;
    this.#listHolds = db.prepare("SELECT room_id, name_hash, seat FROM seat_holds ORDER BY room_id, seat");
    this.#insertHold = db.prepare("INSERT OR REPLACE INTO seat_holds (room_id, name_hash, seat) VALUES (?, ?, ?)");
    this.#list = db.prepare(
      "SELECT id, title, created_at, layout, embed, visibility, pinned, owner_hash, invite_hash, last_active_at, control_policy, item_id FROM rooms ORDER BY created_at, id",
    );
    this.#listQueue = db.prepare("SELECT room_id, id, embed FROM queue_items ORDER BY room_id, position");
    // Appended after the room's last item; the room must exist (foreign key).
    this.#insertQueueItem = db.prepare(
      "INSERT INTO queue_items (room_id, id, position, embed) SELECT ?1, ?2, coalesce(max(position), 0) + 1, ?3 FROM queue_items WHERE room_id = ?4",
    );
    this.#deleteQueueItem = db.prepare("DELETE FROM queue_items WHERE room_id = ? AND id = ?");
    this.#insert = db.prepare(
      "INSERT INTO rooms (id, title, created_at, layout, visibility, pinned, owner_hash, invite_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#delete = db.prepare("DELETE FROM rooms WHERE id = ?");
    this.#setLayout = db.prepare("UPDATE rooms SET layout = ? WHERE id = ?");
    this.#setEmbed = db.prepare("UPDATE rooms SET embed = ?, item_id = ? WHERE id = ?");
    this.#setTitle = db.prepare("UPDATE rooms SET title = ? WHERE id = ?");
    this.#setPinned = db.prepare("UPDATE rooms SET pinned = ? WHERE id = ?");
    this.#setLastActive = db.prepare("UPDATE rooms SET last_active_at = ? WHERE id = ?");
    this.#setControlPolicy = db.prepare("UPDATE rooms SET control_policy = ? WHERE id = ?");
  }

  listRooms(): StoredRoom[] {
    const queues = this.#queues();
    return this.#list.all().map((row) => {
      const parsed = v.safeParse(RowSchema, row);
      if (!parsed.success) {
        const where = typeof row.id === "string" ? JSON.stringify(row.id) : "?";
        throw new Error(`corrupt rooms row ${where}: ${v.summarize(parsed.issues)}`);
      }
      const r = parsed.output;
      return {
        id: r.id,
        title: r.title,
        createdAt: r.created_at,
        layout: r.layout,
        embed: r.embed,
        visibility: r.visibility,
        pinned: r.pinned === 1,
        ownerHash: r.owner_hash,
        inviteHash: r.invite_hash,
        lastActiveAt: r.last_active_at,
        controlPolicy: r.control_policy,
        // An item id without an embed means nothing (a hand edit): dropped.
        itemId: r.embed === null ? null : r.item_id,
        queue: queues.get(r.id) ?? [],
      };
    });
  }

  /** Every room's upcoming items, in play order. A row that fails to parse is dropped and logged without its ids (ADR 0031 §6). */
  #queues(): Map<RoomId, StoredQueueItem[]> {
    const queues = new Map<RoomId, StoredQueueItem[]>();
    for (const row of this.#listQueue.all()) {
      const parsed = v.safeParse(QueueRowSchema, row);
      if (!parsed.success) {
        logError("store.queue_item", new Error(v.summarize(parsed.issues)));
        continue;
      }
      const { room_id: roomId, id, embed } = parsed.output;
      const queue = queues.get(roomId);
      if (queue === undefined) queues.set(roomId, [{ id, embed }]);
      else queue.push({ id, embed });
    }
    return queues;
  }

  createRoom(room: NewRoom): void {
    const r = v.parse(NewRoomSchema, room);
    this.#insert.run(r.id, r.title, r.createdAt, JSON.stringify(r.layout), r.visibility, r.pinned ? 1 : 0, r.ownerHash, r.inviteHash);
  }

  /** Deletes the room's row (owner delete, GC, operator). False if there was none. */
  deleteRoom(id: RoomId): boolean {
    return this.#delete.run(id).changes > 0;
  }

  setLayout(id: RoomId, layout: RoomLayout): void {
    const json = JSON.stringify(v.parse(RoomLayoutSchema, layout));
    if (this.#setLayout.run(json, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  setTitle(id: RoomId, title: string): void {
    const parsed = v.parse(TitleSchema, title);
    if (this.#setTitle.run(parsed, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  /** A share: the new embed and its item id in one write (ADR 0031 §1). A null embed has no item id. */
  setEmbed(id: RoomId, embed: AnyEmbed | null, itemId: QueueItemId | null = null): void {
    const parsed = v.parse(NullableEmbedSchema, embed);
    const json = parsed === null ? null : JSON.stringify(parsed);
    const item = parsed === null ? null : v.parse(v.nullable(QueueItemIdSchema), itemId);
    if (this.#setEmbed.run(json, item, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  /** `queue-add` (ADR 0031 §6): appends one item. Throws for an unknown room, a taken id or an invalid item. */
  addQueueItem(roomId: RoomId, item: StoredQueueItem): void {
    const { id, embed } = v.parse(QueueItemSchema, item);
    this.#insertQueueItem.run(roomId, id, JSON.stringify(embed), roomId);
  }

  /**
   * An add into a room with no current item (ADR 0031 §5, "Starting from an empty room"), in one
   * transaction: appends `item`, then the queue's `head` (usually `item`) leaves it and becomes current.
   * Throws, changing nothing, if either step fails.
   */
  addQueueItemAndStart(roomId: RoomId, item: StoredQueueItem, head: StoredQueueItem): void {
    const added = v.parse(QueueItemSchema, item);
    const started = v.parse(QueueItemSchema, head);
    this.#db.transaction(() => {
      this.#insertQueueItem.run(roomId, added.id, JSON.stringify(added.embed), roomId);
      if (this.#deleteQueueItem.run(roomId, started.id).changes === 0) throw new Error(`no queue item ${JSON.stringify(started.id)}`);
      if (this.#setEmbed.run(JSON.stringify(started.embed), started.id, roomId).changes === 0) throw new Error(`no room ${JSON.stringify(roomId)}`);
    })();
  }

  /** `queue-remove`: false if the room had no such item. */
  removeQueueItem(roomId: RoomId, itemId: QueueItemId): boolean {
    return this.#deleteQueueItem.run(roomId, itemId).changes > 0;
  }

  /**
   * An advance (ADR 0031 §5), in one transaction: the upcoming `item` leaves the queue and becomes the
   * room's current embed. Throws, changing nothing, if the room doesn't hold that item.
   */
  advanceQueue(roomId: RoomId, item: StoredQueueItem): void {
    const { id, embed } = v.parse(QueueItemSchema, item);
    this.#db.transaction(() => {
      if (this.#deleteQueueItem.run(roomId, id).changes === 0) throw new Error(`no queue item ${JSON.stringify(id)}`);
      this.#setEmbed.run(JSON.stringify(embed), id, roomId);
    })();
  }

  /** Room GC's clock (threat model §1.3): written when the room fills or empties, never per message. */
  setLastActive(id: RoomId, at: number): void {
    const ms = v.parse(UnixMsSchema, at);
    if (this.#setLastActive.run(ms, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  /** The owner's `control-policy` (ADR 0030 §4): a rare owner edit, never on the relay path. */
  setControlPolicy(id: RoomId, policy: ControlPolicy): void {
    const parsed = v.parse(ControlPolicySchema, policy);
    if (this.#setControlPolicy.run(parsed, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  /** Pins (GC never collects it) or unpins a room (operator CLI). */
  setPinned(id: RoomId, pinned: boolean): void {
    if (this.#setPinned.run(pinned ? 1 : 0, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  /** Replaces the stored holds with these (graceful restart, ADR 0032). Holds for unknown rooms fail the write. */
  saveSeatHolds(holds: readonly SeatHold[]): void {
    this.#db.transaction(() => {
      this.#db.run("DELETE FROM seat_holds");
      for (const h of holds) this.#insertHold.run(h.roomId, h.nameHash, h.seat);
    })();
  }

  /** The stored holds, deleted as they are read: a hold is used by one boot at most. Bad rows are dropped. */
  takeSeatHolds(): SeatHold[] {
    return this.#db.transaction(() => {
      const holds: SeatHold[] = [];
      for (const row of this.#listHolds.all()) {
        const parsed = v.safeParse(SeatHoldRowSchema, row);
        if (parsed.success) holds.push({ roomId: parsed.output.room_id, nameHash: new Uint8Array(parsed.output.name_hash), seat: parsed.output.seat });
      }
      this.#db.run("DELETE FROM seat_holds");
      return holds;
    })();
  }
}
