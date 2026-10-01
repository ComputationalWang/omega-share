import type { Database, Statement } from "bun:sqlite";
import * as v from "valibot";
import { EmbedSchema, RoomIdSchema, RoomLayoutSchema, type Embed, type RoomId, type RoomLayout } from "@omega/shared";

export interface StoredRoom {
  id: RoomId;
  title: string;
  /** Unix ms. */
  createdAt: number;
  layout: RoomLayout;
  embed: Embed | null;
}

/** The DB file is a boundary too (D4): hand edits, restores and old versions all pass this parse. */
const RowSchema = v.object({
  id: RoomIdSchema,
  title: v.string(),
  created_at: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  layout: v.pipe(v.string(), v.parseJson(), RoomLayoutSchema),
  embed: v.nullable(v.pipe(v.string(), v.parseJson(), EmbedSchema)),
});

const NewRoomSchema = v.object({
  id: RoomIdSchema,
  title: v.string(),
  createdAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  layout: RoomLayoutSchema,
});

const NullableEmbedSchema = v.nullable(EmbedSchema);

type Row = Record<keyof v.InferInput<typeof RowSchema>, unknown>;

/**
 * Write-through persistence for rooms (research §2.4). Only the rare mutations land here (room
 * created, layout set, embed changed), never the relay path. Every value is parsed on write and
 * every row on read; a corrupt row throws, naming the room.
 */
export class RoomStore {
  readonly #list: Statement<Row, []>;
  readonly #insert: Statement<unknown, [string, string, number, string]>;
  readonly #setLayout: Statement<unknown, [string, string]>;
  readonly #setEmbed: Statement<unknown, [string | null, string]>;

  constructor(db: Database) {
    this.#list = db.prepare("SELECT id, title, created_at, layout, embed FROM rooms ORDER BY created_at, id");
    this.#insert = db.prepare("INSERT INTO rooms (id, title, created_at, layout) VALUES (?, ?, ?, ?)");
    this.#setLayout = db.prepare("UPDATE rooms SET layout = ? WHERE id = ?");
    this.#setEmbed = db.prepare("UPDATE rooms SET embed = ? WHERE id = ?");
  }

  listRooms(): StoredRoom[] {
    return this.#list.all().map((row) => {
      const parsed = v.safeParse(RowSchema, row);
      if (!parsed.success) {
        const where = typeof row.id === "string" ? JSON.stringify(row.id) : "?";
        throw new Error(`corrupt rooms row ${where}: ${v.summarize(parsed.issues)}`);
      }
      const r = parsed.output;
      return { id: r.id, title: r.title, createdAt: r.created_at, layout: r.layout, embed: r.embed };
    });
  }

  createRoom(room: { id: string; title: string; createdAt: number; layout: RoomLayout }): void {
    const r = v.parse(NewRoomSchema, room);
    this.#insert.run(r.id, r.title, r.createdAt, JSON.stringify(r.layout));
  }

  setLayout(id: RoomId, layout: RoomLayout): void {
    const json = JSON.stringify(v.parse(RoomLayoutSchema, layout));
    if (this.#setLayout.run(json, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }

  setEmbed(id: RoomId, embed: Embed | null): void {
    const parsed = v.parse(NullableEmbedSchema, embed);
    const json = parsed === null ? null : JSON.stringify(parsed);
    if (this.#setEmbed.run(json, id).changes === 0) throw new Error(`no room ${JSON.stringify(id)}`);
  }
}
