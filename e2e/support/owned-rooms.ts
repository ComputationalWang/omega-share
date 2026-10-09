// Rooms with known owner tokens and invite keys, for the QA rooms specs (OME-417). POST /rooms is rate limited (2 per
// client per 10 min, 10 per minute server-wide), and rooms-web / owner-editor already spend it from the browser, so
// these specs don't create rooms: the e2e server boots from a DB seeded with them (fixtures/seed-rooms.ts), stored
// the way a created room is (unpinned, only the SHA-256 of each secret), so delete, title-set and layout-set work.
// One room per test that mutates or deletes one: a deleted room is gone for the rest of the run (and for a retry).
// No imports: the seed script reads this under bun before any server exists.

/** A room per use. Names are letters only, so the id stays valid base32 (a-z, 2-7), and at most 9 long so the owner token stays 22 chars. */
export const OWNED_ROOM_NAMES = ["invite", "owner", "delete", "ux", "extlist", "extopen", "extsecret", "extdelete", "extqplaya", "extqplayb", "extqplayc", "extqplayd", "extqplaye", "extqplayf", "extqempa", "extqempb", "extqempc", "extqempd", "extqempe", "extqempf", "real", "refused", "mod", "modperf", "modkick", "modmute", "modpolicy", "abmod", "abforge", "abcap", "abrate", "abbad", "abhost", "abgen", "abshape", "abkick", "abended", "chatmod"] as const;
export type OwnedRoomName = (typeof OWNED_ROOM_NAMES)[number];

export interface OwnedRoom {
  readonly name: OwnedRoomName;
  /** 26 chars of lowercase base32, like a created room's id. */
  readonly id: string;
  readonly title: string;
  readonly visibility: "private";
  /** 22 chars of base64url, like a minted secret. */
  readonly ownerToken: string;
  readonly inviteKey: string;
}

const make = (name: OwnedRoomName): OwnedRoom => ({
  name,
  id: `qaowned${name}`.padEnd(26, "a"),
  title: `QA owned ${name}`,
  visibility: "private",
  ownerToken: `QaOwnerToken-${name}`.padEnd(22, "x"),
  inviteKey: `QaInviteKey-${name}`.padEnd(22, "y"),
});

/** Every owned room, in seeding order. */
export const OWNED_ROOMS: readonly OwnedRoom[] = OWNED_ROOM_NAMES.map(make);

export const ownedRoom = (name: OwnedRoomName): OwnedRoom => make(name);
