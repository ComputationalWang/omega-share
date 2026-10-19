import * as v from "valibot";
import { AccessorySchema, AvatarSchema, NICKNAME_MAX_LENGTH, NicknameSchema, TintSchema, type Accessory, type Avatar, type Hair, type Nickname, type Tint } from "@omega/shared";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Profile {
  readonly nickname: Nickname | null;
  readonly avatar: Avatar;
  readonly tint: Tint;
  /** Avatar accessory (OME-1391), 0 none. */
  readonly accessory: Accessory;
  /** Hair colour (OME-1438), 0 the avatar's own. */
  readonly hair: Hair;
}

const NICKNAME_KEY = "omega.nickname";
const AVATAR_KEY = "omega.avatar";
const TINT_KEY = "omega.tint";
const ACCESSORY_KEY = "omega.accessory";

export type NicknameResult = { readonly ok: true; readonly nickname: Nickname } | { readonly ok: false; readonly message: string };

export function validateNickname(raw: string): NicknameResult {
  const r = v.safeParse(NicknameSchema, raw);
  if (r.success) return { ok: true, nickname: r.output };
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, message: "Pick a nickname." };
  if (trimmed.length > NICKNAME_MAX_LENGTH) return { ok: false, message: `At most ${String(NICKNAME_MAX_LENGTH)} characters.` };
  return { ok: false, message: "Letters, digits, spaces and _ . - only." };
}

function read(store: KeyValueStore, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}

/** Stored values are untrusted (anyone can edit localStorage): re-validate. */
export function loadProfile(store: KeyValueStore): Profile {
  const nick = v.safeParse(NicknameSchema, read(store, NICKNAME_KEY));
  const avatar = v.safeParse(AvatarSchema, Number(read(store, AVATAR_KEY) ?? "0"));
  const tint = v.safeParse(TintSchema, Number(read(store, TINT_KEY) ?? "0"));
  const accessory = v.safeParse(AccessorySchema, Number(read(store, ACCESSORY_KEY) ?? "0"));
  return { nickname: nick.success ? nick.output : null, avatar: avatar.success ? avatar.output : 0, tint: tint.success ? tint.output : 0, accessory: accessory.success ? accessory.output : 0, hair: 0 };
}

export function saveProfile(store: KeyValueStore, profile: { nickname: Nickname; avatar: Avatar }): boolean {
  try {
    store.setItem(NICKNAME_KEY, profile.nickname);
    store.setItem(AVATAR_KEY, String(profile.avatar));
    return true;
  } catch {
    return false;
  }
}

/** The shirt tint (ADR 0053) is saved on its own: a pick in the room changes it with no nickname to hand. */
export function saveTint(store: KeyValueStore, tint: Tint): boolean {
  try {
    store.setItem(TINT_KEY, String(tint));
    return true;
  } catch {
    return false;
  }
}

/** Likewise the accessory (OME-1391). */
export function saveAccessory(store: KeyValueStore, accessory: Accessory): boolean {
  try {
    store.setItem(ACCESSORY_KEY, String(accessory));
    return true;
  } catch {
    return false;
  }
}

/** Likewise the hair colour (OME-1438). */
export function saveHair(_store: KeyValueStore, _hair: Hair): boolean {
  return false;
}
