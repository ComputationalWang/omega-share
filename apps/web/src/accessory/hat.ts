// Head accessories (OME-1391): which hat a member wears. Tiny and dependency-free so the room view imports it statically;
// the sheet itself (accessories-sheet.ts) is a lazy chunk, fetched only once someone in the room wears an accessory.

/** Accessory 1..4 on the wire, by their sheet ids (assets/accessories, OME-1388); 0 is none. */
export const ACCESSORY_IDS = ["partyhat", "crown", "headphones", "beanie"] as const;

/**
 * The one hat over an avatar frame: the member's own accessory, else the holiday theme's (ADR 0052). Until the sheet is
 * in, or for a frame it has no hat for, the theme's hat stands in.
 */
export function wornHat<T>(accessory: number, frame: string, accessories: { hat(accessory: number, frame: string): T | undefined } | null, theme: { hat(frame: string): T | undefined } | null): T | undefined {
  return (accessory > 0 ? accessories?.hat(accessory, frame) : undefined) ?? theme?.hat(frame);
}

/** Whether `avatar` wearing `accessory` is drawn on its bare-head frame. */
export function wearsBare(_avatar: number, _accessory: number): boolean {
  return false;
}
