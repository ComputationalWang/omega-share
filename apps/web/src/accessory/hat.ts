// Head accessories (OME-1391): which hat a member wears. Tiny and dependency-free so the room view imports it statically;
// the sheet itself (accessories-sheet.ts) is a lazy chunk, fetched only once someone in the room wears an accessory.

/** Accessory 1..8 on the wire, by their sheet ids (assets/accessories, OME-1388; 5..8 OME-1530); 0 is none. */
export const ACCESSORY_IDS = ["partyhat", "crown", "headphones", "beanie", "cap", "flower", "bow", "halo"] as const;

/**
 * The one hat over an avatar frame: the member's own accessory, else the holiday theme's (ADR 0052). Until the sheet is
 * in, or for a frame it has no hat for, the theme's hat stands in. Either comes in `avatar`'s `hair` copy (OME-1438).
 */
export function wornHat<T>(
  accessory: number,
  frame: string,
  accessories: { hat(accessory: number, frame: string, avatar: number, hair: number): T | undefined } | null,
  theme: { hat(frame: string, avatar: number, hair: number): T | undefined } | null,
  avatar = 0,
  hair = 0,
): T | undefined {
  return (accessory > 0 ? accessories?.hat(accessory, frame, avatar, hair) : undefined) ?? theme?.hat(frame, avatar, hair);
}

/**
 * Whether `avatar` wearing `accessory` is drawn on its bare-head frame (OME-1409): Pip and Mo (1, 2) under the party hat,
 * crown, headphones, cap or bow. The sheets' `meta.omega.bare`, pinned by accessory-sheet.test.ts: copied here because the
 * room must know before it fetches bare.json, and importing that would put its frames in the main chunk.
 */
export function wearsBare(avatar: number, accessory: number): boolean {
  return (avatar === 1 || avatar === 2) && BARE.has(accessory);
}

const BARE: ReadonlySet<number> = new Set([1, 2, 3, 5, 7]);
