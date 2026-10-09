-- Abuse reports and takedowns (ADR 0033 §3, §5). Nothing about the reporter: no address, key, agent or
-- member. `note` is the parsed note after redaction. No foreign key to rooms: a report outlives its room
-- (actioned after a takedown) until the retention sweep deletes it, 30 days after created_at.
CREATE TABLE reports (
  id         TEXT    NOT NULL PRIMARY KEY CHECK (length(id) = 22),
  room_id    TEXT    NOT NULL,
  reason     TEXT    NOT NULL,
  note       TEXT,
  room_title TEXT,
  embed_url  TEXT,
  created_at INTEGER NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'dismissed', 'actioned'))
) STRICT;
CREATE INDEX reports_created_at ON reports (created_at);
CREATE INDEX reports_room_state ON reports (room_id, state);
-- A taken-down room id is never served, minted or seeded again. Not personal data: kept indefinitely.
CREATE TABLE takedowns (
  room_id TEXT    NOT NULL PRIMARY KEY,
  at      INTEGER NOT NULL
) STRICT;
