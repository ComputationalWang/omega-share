import type { Database, Statement } from "bun:sqlite";
import * as v from "valibot";
import {
  AnyEmbedSchema,
  RoomIdSchema,
  RoomLayoutSchema,
  RoomTitleSchema,
  RoomVisibilitySchema,
  type AnyEmbed,
  type RoomId,
  type RoomLayout,
  type RoomVisibility,
} from "@omega/shared";

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
  readonly #setEmbed: Statement<unknown, [string | null, string]>;
  readonly #setTitle: Statement<unknown, [string, string]>;
  readonly #setLastActive: Statement<unknown, [number, string]>;

  constructor(db: Database) {
    this.#list = db.prepare(
      "SELECT id, title, created_at, layout, embed, visibility, pinned, owner_hash, invite_hash, last_active_at FROM rooms ORDER BY created_at, id",
    );
    this.#insert = db.prepare(
      "INSERT INTO rooms (id, title, created_at, layout, visibility, pinned, owner_hash, invite_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#delete = db.prepare("DELETE FROM rooms WHERE id = ?");
    this.#setLayout = db.prepare("UPDATE rooms SET layout = ? WHERE id = ?");
    this.#setEmbed = db.prepare("UPDATE rooms SET embed = ? WHERE id = ?");
    this.#setTitle = db.prepare("UPDATE rooms SET title = ? WHERE id = ?");
    this.#setLastActive = db.prepare("UPDATE rooms SET last_active_at = ? WHERE id = ?");
  }

  listRooms(): StoredRoom[] {
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
      };
    });
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

  setEmbed(id: RoomId, embed: AnyEmbed | null): void {
    const parsed = v.parse(NullableEmbedSchema, embed);
    const json = parsed === null ? null : JSON.stringify(parsed);
    if (this.#setEmbed.run(json, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  /** Room GC's clock (threat model §1.3): written when the room fills or empties, never per message. */
  setLastActive(id: RoomId, at: number): void {
    const ms = v.parse(UnixMsSchema, at);
    if (this.#setLastActive.run(ms, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }
}
