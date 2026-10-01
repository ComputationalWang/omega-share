// Server-only entry ("@omega/shared/confusables"): it carries the UTS #39 table
// (~5k entries), which must never reach the web bundle. ADR 0022.
import { CONFUSABLES } from "./confusables-table";
import type { Nickname } from "./room";

export { CONFUSABLES_VERSION } from "./confusables-table";

let prototypes: Map<string, string> | null = null;

function table(): Map<string, string> {
  if (prototypes !== null) return prototypes;
  const map = new Map<string, string>();
  for (const entry of CONFUSABLES.split("\n")) {
    const source = entry.codePointAt(0);
    if (source === undefined) continue;
    const from = String.fromCodePoint(source);
    map.set(from, entry.slice(from.length));
  }
  prototypes = map;
  return map;
}

/** UTS #39 skeleton: NFD, each code point replaced by its confusables.txt prototype, NFD. */
export function skeleton(input: string): string {
  const map = table();
  let out = "";
  for (const c of input.normalize("NFD")) out += map.get(c) ?? c;
  return out.normalize("NFD");
}

const CAPITAL = /[\p{Lu}\p{Lt}]/u;

/**
 * Per-room uniqueness key (M4, ADR 0022): two members of a room may not share one.
 * The UTS #39 skeleton, made case-insensitive: lowercase, skeleton again (prototypes can
 * be capitals, e.g. "0" → "O"), then combining marks removed. So "Alice", "ALICE",
 * "Аӏісе" (Cyrillic), "A1ice", "Alicé" collide, and so do "TOM" and Greek "ΤΟΜ".
 * Case beats case-crossing confusables: a capital whose prototype has no capital
 * ("I" → "l") is lowercased first, so "ALICE" is "alice" and "AIice" stays "aiice".
 */
export function nicknameKey(nickname: Nickname): string {
  const map = table();
  let folded = "";
  for (const c of nickname.normalize("NFD")) {
    const prototype = map.get(c);
    if (prototype === undefined) folded += c;
    else if (CAPITAL.test(c) && !CAPITAL.test(prototype)) folded += skeleton(c.toLowerCase());
    else folded += prototype;
  }
  return skeleton(folded.normalize("NFD").toLowerCase()).replace(/\p{M}/gu, "");
}
