-- Playback queue (ADR 0031 §6). Upcoming items in play order; `embed` is AnyEmbedSchema JSON, parsed on
-- every read. No `by` column: nothing on disk says who queued what (ADR 0028 §7). A room's rows go with it.
CREATE TABLE queue_items (
  room_id  TEXT    NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  id       TEXT    NOT NULL CHECK (length(id) BETWEEN 1 AND 32),
  position INTEGER NOT NULL,
  embed    TEXT    NOT NULL,
  PRIMARY KEY (room_id, id)
) STRICT;
-- The current embed's item id; NULL with no embed, and for embeds stored before 0005.
ALTER TABLE rooms ADD COLUMN item_id TEXT;
