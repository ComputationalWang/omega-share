-- Seats held across a graceful restart (OME-504, ADR 0032). Written on SIGTERM, read and emptied at
-- the next boot, so rows live only for the length of a restart. A name is stored only as SHA-256 of
-- its nickname key: never the nickname, the member id or an address.
CREATE TABLE seat_holds (
  room_id    TEXT    NOT NULL REFERENCES rooms (id) ON DELETE CASCADE,
  name_hash  BLOB    NOT NULL CHECK (length(name_hash) = 32),
  seat       INTEGER NOT NULL CHECK (seat >= 0),
  PRIMARY KEY (room_id, name_hash)
) STRICT;
