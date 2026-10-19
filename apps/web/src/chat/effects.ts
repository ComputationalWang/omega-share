// Chat effects (OME-1349), all at zero wire cost: a slash command sends the existing `emote`; a chat sticker and the
// shout bubble are read locally from the relayed text by every viewer.
import { DICE_MAX_SIDES, DICE_MIN_SIDES, type EmoteKind, type MemberId } from "@omega/shared";
import { PICKER_KINDS } from "../emote/emotes";
import type { SystemLine } from "../controls/sysline";

export type SlashCommand =
  | { readonly type: "emote"; readonly kind: EmoteKind }
  | { readonly type: "help" }
  | { readonly type: "roll"; readonly sides: number }
  | { readonly type: "roll-usage" }
  | { readonly type: "hug"; readonly kind: "heart" | "clap"; readonly name: string }
  | { readonly type: "hug-usage" };

/** `/wave` … `/exclaim` (each emote's own name), `/help`, `/roll [n|dn]` and `/hug|/highfive <name>` (OME-1453); anything else, `/x` included, is chat. */
export function slashCommand(text: string): SlashCommand | null {
  const hug = /^\s*\/(hug|highfive)(?:\s+(.*?))?\s*$/is.exec(text);
  if (hug !== null) {
    const name = hug[2] ?? "";
    return name === "" ? { type: "hug-usage" } : { type: "hug", kind: hug[1]?.toLowerCase() === "hug" ? "heart" : "clap", name };
  }
  const t = text.trim().toLowerCase();
  if (t === "/help") return { type: "help" };
  if (t === "/roll") return { type: "roll", sides: 6 };
  if (t.startsWith("/roll ")) {
    const sides = Number(/^\/roll\s+d?(\d{1,3})$/.exec(t)?.[1]);
    return sides >= DICE_MIN_SIDES && sides <= DICE_MAX_SIDES ? { type: "roll", sides } : { type: "roll-usage" };
  }
  const kind = PICKER_KINDS.find((k) => t === `/${k}`);
  return kind === undefined ? null : { type: "emote", kind };
}

/** `/me <text>` (OME-1375): the action, or null. */
export function meAction(text: string): string | null {
  return /^\s*\/me\s+(\S.*?)\s*$/is.exec(text)?.[1] ?? null;
}

/** What `/help` says, to me only. */
export const HELP_LINE: SystemLine = { glyph: "host", actor: null, verb: `Emotes: ${PICKER_KINDS.map((k) => `/${k}`).join(" ")} · /me <action> · /roll [sides] · /hug <name> · /highfive <name>`, time: null, self: true };

/** What a `/roll` the server would refuse says (OME-1426), to me only; nothing is sent. */
export const ROLL_USAGE_LINE: SystemLine = { glyph: "host", actor: null, verb: `Roll a die: /roll, /roll 20 or /roll d20 (${String(DICE_MIN_SIDES)}–${String(DICE_MAX_SIDES)} sides)`, time: null, self: true };

/** What `/hug` or `/highfive` with no name says (OME-1453), to me only; nothing is sent. */
export const HUG_USAGE_LINE: SystemLine = { glyph: "host", actor: null, verb: "Hug someone: /hug <name> or /highfive <name>", time: null, self: true };

/** What `/dance` says while I'm seated (OME-1378), to me only; nothing is sent. */
export const DANCE_SEATED_LINE: SystemLine = { glyph: "host", actor: null, verb: "Stand up to dance", time: null, self: true };

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

/** The sticker a roll pops (OME-1426): the cheer on a max roll, else null. */
export function rollSticker(sides: number, value: number): EmoteKind | null {
  return value === sides ? "cheer" : null;
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
