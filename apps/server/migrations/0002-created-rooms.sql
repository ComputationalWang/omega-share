-- Created rooms (ADR 0028, research §1.4). Rows from 0001 are seeds: pinned, public, ownerless.
-- The owner token and invite key are stored only as SHA-256 (32 bytes). No column records who
-- created a room: no address, key, user agent or hash of one (ADR 0028 §7).
ALTER TABLE rooms ADD COLUMN visibility     TEXT    NOT NULL DEFAULT 'public' CHECK (visibility IN ('public', 'private'));
ALTER TABLE rooms ADD COLUMN pinned         INTEGER NOT NULL DEFAULT 1 CHECK (pinned IN (0, 1));
ALTER TABLE rooms ADD COLUMN owner_hash     BLOB    CHECK (owner_hash IS NULL OR length(owner_hash) = 32);
ALTER TABLE rooms ADD COLUMN invite_hash    BLOB    CHECK (invite_hash IS NULL OR length(invite_hash) = 32);
-- Unix ms the room last became empty (or occupied); NULL = never joined. Written by the GC issue.
ALTER TABLE rooms ADD COLUMN last_active_at INTEGER;
