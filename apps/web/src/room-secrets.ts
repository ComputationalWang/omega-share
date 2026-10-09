import * as v from "valibot";
import {
  MAX_ROOM_SECRETS,
  ROOM_SECRETS_STORAGE_KEY,
  RoomSecretsSchema,
  inviteKeyFromHash,
  type Avatar,
  type ClientMessage,
  type InviteKey,
  type Nickname,
  type OwnerToken,
  type RoomId,
  type RoomSecrets,
} from "@omega/shared";

// The site's owner tokens and invite keys (ADR 0028, research §2.3, §3.2). Unlike the share token they outlive the tab,
// so "come back tomorrow" works. Never in a URL; the extension never reads this key.

export interface SecretsStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type RoomSecret = RoomSecrets["rooms"][string];

const empty = (): RoomSecrets => ({ v: 1, rooms: {} });

/** localStorage is untrusted (anyone can edit it): anything that doesn't parse reads as no rooms. Never throws. */
export function loadRoomSecrets(store: Pick<SecretsStore, "getItem">): RoomSecrets {
  try {
    const raw = store.getItem(ROOM_SECRETS_STORAGE_KEY);
    if (raw === null) return empty();
    const r = v.safeParse(RoomSecretsSchema, JSON.parse(raw));
    return r.success ? r.output : empty();
  } catch {
    return empty();
  }
}

function save(store: SecretsStore, rooms: Record<string, RoomSecret>): boolean {
  const record: RoomSecrets = { v: 1, rooms };
  try {
    store.setItem(ROOM_SECRETS_STORAGE_KEY, JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges `secret` into the room's record and makes it the newest. Past MAX_ROOM_SECRETS, invite-only rooms go first,
 * oldest first, and only then rooms you own: every `#k=` link is saved before its key is known to work, and an owner
 * token can't be recovered (OME-458). Age is the key order, which JSON keeps. Digit-only ids (seeded rooms) are
 * array-index keys, which objects sort first, so they aren't saved: no such room has a secret (created ids are 26 chars).
 */
export function rememberRoom(store: SecretsStore, id: RoomId, secret: RoomSecret): boolean {
  if (/^\d+$/.test(id)) return false;
  const { [id]: prev, ...rest } = loadRoomSecrets(store).rooms;
  const entries = Object.entries(rest);
  let excess = entries.length - (MAX_ROOM_SECRETS - 1);
  const dropped = new Set<string>();
  for (const owned of [false, true]) {
    for (const [k, s] of entries) {
      if (excess <= 0) break;
      if ((s.ownerToken !== undefined) !== owned) continue;
      dropped.add(k);
      excess -= 1;
    }
  }
  const rooms: Record<string, RoomSecret> = {};
  for (const [k, s] of entries) if (!dropped.has(k)) rooms[k] = s;
  rooms[id] = { ...prev, ...secret };
  return save(store, rooms);
}

export function forgetRoom(store: SecretsStore, id: RoomId): boolean {
  return save(store, Object.fromEntries(Object.entries(loadRoomSecrets(store).rooms).filter(([k]) => k !== id)));
}

/**
 * Boot step, before anything that could load a provider SDK (the Twitch SDK sends location.href to Twitch): reads a
 * `#k=` fragment, saves its key for `roomId` (null off a room path) and drops the fragment with replaceState.
 * A malformed `#k=` is dropped too. Any other fragment is left alone.
 */
export function takeInviteKey(
  loc: Pick<Location, "hash" | "pathname" | "search">,
  history: Pick<History, "replaceState" | "state">,
  store: SecretsStore,
  roomId: RoomId | null,
): InviteKey | null {
  const hash = loc.hash;
  if (!hash.startsWith("#k=")) return null;
  const key = inviteKeyFromHash(hash);
  history.replaceState(history.state, "", loc.pathname + loc.search);
  if (key === null || roomId === null) return null;
  rememberRoom(store, roomId, { inviteKey: key });
  return key;
}

/** What `join` uses for `id`: the stored record, with a key just taken from the URL on top (storage may have refused it). */
export function secretFor(secrets: RoomSecrets, id: RoomId, invited: InviteKey | null): RoomSecret | undefined {
  const stored = secrets.rooms[id];
  return invited === null ? stored : { ...stored, inviteKey: invited };
}

/** The link "Copy invite link" hands out: the room URL, plus the key in the fragment for a private room. */
export function inviteLink(origin: string, id: RoomId, inviteKey?: InviteKey): string {
  return `${origin}/r/${id}${inviteKey === undefined ? "" : `#k=${inviteKey}`}`;
}

/** `join` with the room's stored secrets; absent ones are left out (the server's join is a strictObject). */
export function joinMessage(nickname: Nickname, avatar: Avatar, secret: RoomSecret | undefined): Extract<ClientMessage, { type: "join" }> {
  const ownerToken: OwnerToken | undefined = secret?.ownerToken;
  const inviteKey: InviteKey | undefined = secret?.inviteKey;
  return {
    type: "join",
    nickname,
    avatar,
    ...(ownerToken === undefined ? {} : { ownerToken }),
    ...(inviteKey === undefined ? {} : { inviteKey }),
  };
}
