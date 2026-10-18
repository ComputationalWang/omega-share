// Chat effects (OME-1349), all at zero wire cost: a slash command sends the existing `emote`; a chat sticker and the
// shout bubble are read locally from the relayed text by every viewer.
import type { EmoteKind, MemberId } from "@omega/shared";
import { PICKER_KINDS } from "../emote/emotes";
import type { SystemLine } from "../controls/sysline";

export type SlashCommand = { readonly type: "emote"; readonly kind: EmoteKind } | { readonly type: "help" };

/** `/wave` … `/exclaim` (each emote's own name) and `/help`; anything else, `/x` included, is chat. */
export function slashCommand(text: string): SlashCommand | null {
  const t = text.trim().toLowerCase();
  if (t === "/help") return { type: "help" };
  const kind = PICKER_KINDS.find((k) => t === `/${k}`);
  return kind === undefined ? null : { type: "emote", kind };
}

/** `/me <text>` (OME-1375): the action, or null. */
export function meAction(_text: string): string | null {
  return null;
}

/** What `/help` says, to me only. */
export const HELP_LINE: SystemLine = { glyph: "host", actor: null, verb: `Emotes: ${PICKER_KINDS.map((k) => `/${k}`).join(" ")}`, time: null, self: true };

const STICKERS: readonly (readonly [RegExp, EmoteKind])[] = [
  [/<3/, "heart"],
  [/\b(?:lol+|ha(?:ha)+h?)\b/i, "laugh"],
  [/!!/, "exclaim"],
  [/\?\?/, "question"],
];

/** The sticker a chat line pops, or null. */
export function chatSticker(text: string): EmoteKind | null {
  for (const [re, kind] of STICKERS) if (re.test(text)) return kind;
  return null;
}

/** All caps, 4+ letters: no lowercase anywhere. */
export function isShout(text: string): boolean {
  return text === text.toUpperCase() && (text.match(/\p{Lu}/gu)?.length ?? 0) >= 4;
}

export const STICKER_GAP_MS = 3000;

export interface StickerGate {
  /** True if `id` may pop a sticker at `now` (and counts it). */
  allow(id: MemberId, now: number): boolean;
}

export function createStickerGate(): StickerGate {
  // shortcut: never forgets a member who left (a few bytes each), prune on leave if rooms ever run for days.
  const last = new Map<MemberId, number>();
  return {
    allow(id, now) {
      const at = last.get(id);
      if (at !== undefined && now - at < STICKER_GAP_MS) return false;
      last.set(id, now);
      return true;
    },
  };
}
