// Chat effects (OME-1349): slash emotes, chat stickers and the shout bubble, all read locally from the text.
import type { EmoteKind, MemberId } from "@omega/shared";

export type SlashCommand = { readonly type: "emote"; readonly kind: EmoteKind } | { readonly type: "help" };

export function slashCommand(_text: string): SlashCommand | null {
  return null;
}

export function chatSticker(_text: string): EmoteKind | null {
  return null;
}

export function isShout(_text: string): boolean {
  return false;
}

export const STICKER_GAP_MS = 0;

export interface StickerGate {
  allow(id: MemberId, now: number): boolean;
}

export function createStickerGate(): StickerGate {
  return { allow: () => false };
}
