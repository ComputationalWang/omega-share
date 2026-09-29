import * as v from "valibot";
import { AvatarSchema, NICKNAME_MAX_LENGTH, NicknameSchema, type Avatar, type Nickname } from "@omega/shared";

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface Profile {
  readonly nickname: Nickname | null;
  readonly avatar: Avatar;
}

const NICKNAME_KEY = "omega.nickname";
const AVATAR_KEY = "omega.avatar";

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
  return { nickname: nick.success ? nick.output : null, avatar: avatar.success ? avatar.output : 0 };
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
