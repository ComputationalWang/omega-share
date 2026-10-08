import { createHash, timingSafeEqual } from "node:crypto";
import type { RoomId } from "@omega/shared";

/** 16 random bytes, base64url without padding: 22 chars (share tokens, owner tokens, invite keys; ADR 0015, 0028). */
export const mintSecret = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64url");

/** SHA-256 of a secret: what the store keeps instead of it (ADR 0028 §3). */
export const hashSecret = (secret: string): Uint8Array => new Uint8Array(createHash("sha256").update(secret).digest());

/** Whether `secret` hashes to `hash`, in constant time. False when there is no hash (a pinned room has no owner). */
export function secretMatches(hash: Uint8Array | null, secret: string): boolean {
  if (hash === null) return false;
  return timingSafeEqual(hashSecret(secret), hash);
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** A created room's id: 16 random bytes (128 bits) as lowercase base32, 26 chars (ADR 0028 §1). */
export function newRoomId(): RoomId {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31);
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  // 128 = 25 × 5 + 3: the last 3 bits, padded.
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31);
  return out;
}
