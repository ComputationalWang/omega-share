-- Rooms survive a restart (research §2.2). `layout` is RoomLayoutSchema JSON and `embed` is
-- EmbedSchema JSON or NULL; the server Valibot-parses both on every read (D4).
CREATE TABLE rooms (
  id          TEXT PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 32),
  title       TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  layout      TEXT NOT NULL,
  embed       TEXT
) STRICT;
