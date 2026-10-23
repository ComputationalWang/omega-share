// Chat effects (OME-1349), all at zero wire cost: a slash command sends the existing `emote`; a chat sticker and the
// shout bubble are read locally from the relayed text by every viewer.
import * as v from "valibot";
import { DICE_MAX_SIDES, DICE_MIN_SIDES, POLL_MAX_OPTIONS, POLL_MIN_OPTIONS, PollOptionSchema, PollQuestionSchema, type EmoteKind, type MemberId, type PairPose } from "@omega/shared";
import { commandsFor, type SlashEntry } from "./commands";
import type { SystemLine } from "../controls/sysline";

export type SlashCommand =
  | { readonly type: "emote"; readonly kind: EmoteKind }
  | { readonly type: "help" }
  | { readonly type: "snap" }
  | { readonly type: "sit" }
  | { readonly type: "pet" }
  | { readonly type: "roll"; readonly sides: number }
  | { readonly type: "roll-usage" }
  | { readonly type: "poll"; readonly question: string; readonly options: readonly string[] }
  | { readonly type: "poll-usage" }
  | { readonly type: "hug"; readonly kind: "heart" | "clap"; readonly name: string }
  | { readonly type: "hug-usage" }
  /** `/thrust` or `/bendover` (OME-1672), only where the room's layout has `pairs`. */
  | { readonly type: "pair"; readonly pose: PairPose }
  /** `/me`, `/think`, `/conga`, `/stop`: commands that travel as a chat line. */
  | { readonly type: "line" };

/** `/poll Question? A | B` (OME-1454): the question is the text up to and including the first "?", the options follow, split on "|". */
function pollCommand(rest: string): SlashCommand {
  const m = /^([^?]+\?)(.*)$/s.exec(rest);
  const question = v.safeParse(PollQuestionSchema, m?.[1]?.trim());
  const options = v.safeParse(v.array(PollOptionSchema), m?.[2]?.split("|").map((o) => o.trim()));
  if (!question.success || !options.success || options.output.length < POLL_MIN_OPTIONS || options.output.length > POLL_MAX_OPTIONS) return { type: "poll-usage" };
  return { type: "poll", question: question.output, options: options.output };
}

const slashes = (pairs: boolean): readonly SlashEntry[] => commandsFor(pairs).filter((c): c is SlashEntry => c.section !== "moves");
const SLASHES = slashes(false);
const PAIR_SLASHES = slashes(true);

/** A word of the command table (OME-1586) after a slash: the emotes (or an alias), `/help`, `/snap` (OME-1565), `/sit` (OME-1501), `/roll [n|dn]`, `/poll` and `/hug|/highfive [@]<name>` (OME-1453), and the chat-line ones; anything else, `/x` included, is chat. */
export function slashCommand(text: string, pairs = false): SlashCommand | null {
  const m = /^\s*\/(\S+)(?:\s+(.*?))?\s*$/s.exec(text);
  const word = m?.[1]?.toLowerCase() ?? "";
  const rest = m?.[2] ?? "";
  const c = (pairs ? PAIR_SLASHES : SLASHES).find((e) => e.name === word || e.aliases.includes(word));
  if (c === undefined) return null;
  if (c.emote !== undefined) return rest === "" ? { type: "emote", kind: c.emote } : null;
  switch (c.name) {
    case "help":
    case "snap":
    case "sit":
    case "pet": // OME-1669
      return rest !== "" ? null : { type: c.name };
    case "roll": {
      if (rest === "") return { type: "roll", sides: 6 };
      const sides = Number(/^d?(\d{1,3})$/i.exec(rest)?.[1]);
      return sides >= DICE_MIN_SIDES && sides <= DICE_MAX_SIDES ? { type: "roll", sides } : { type: "roll-usage" };
    }
    case "poll":
      return pollCommand(rest);
    case "hug":
    case "highfive": {
      const name = rest.replace(/^@/, "");
      return name === "" ? { type: "hug-usage" } : { type: "hug", kind: c.name === "hug" ? "heart" : "clap", name };
    }
    case "thrust":
    case "bendover":
      return rest !== "" ? null : { type: "pair", pose: c.name };
    default:
      return { type: "line" };
  }
}

/** `/me <text>` (OME-1375): the action, or null. */
export function meAction(text: string): string | null {
  return /^\s*\/me\s+(\S.*?)\s*$/is.exec(text)?.[1] ?? null;
}

/** `/think <text>` (OME-1465): the thought, or null. */
export function thinkText(text: string): string | null {
  return /^\s*\/think\s+(\S.*?)\s*$/is.exec(text)?.[1] ?? null;
}

/** What `/help` says, to me only: the command table, emotes first; the pair commands only where `pairs` is on. */
export const helpLine = (pairs: boolean): SystemLine => {
  const all = pairs ? PAIR_SLASHES : SLASHES;
  return { glyph: "host", actor: null, verb: `Emotes: ${all.filter((c) => c.section === "emotes").map((c) => c.help).join(" ")} · ${all.filter((c) => c.section === "fun").map((c) => c.help).join(" · ")}`, time: null, self: true };
};
export const HELP_LINE: SystemLine = helpLine(false);

const OTHER_POSE: Readonly<Record<PairPose, PairPose>> = { thrust: "bendover", bendover: "thrust" };

/** A member's open pair invite (OME-1672): "Bob wants to /thrust, to join in use /bendover"; mine reads "You want to …". */
export const pairInvitedLine = (actor: string, me: boolean, pose: PairPose): SystemLine => ({ glyph: "host", actor: me ? "You" : actor, verb: `${me ? "want" : "wants"} to /${pose}, to join in use /${OTHER_POSE[pose]}`, time: null });

/** What a `/poll` the server would refuse says (OME-1454), to me only; nothing is sent. */
export const POLL_USAGE_LINE: SystemLine = { glyph: "host", actor: null, verb: `Poll: /poll Question? A | B | C (${String(POLL_MIN_OPTIONS)}–${String(POLL_MAX_OPTIONS)} options, split on |)`, time: null, self: true };

/** What a `/roll` the server would refuse says (OME-1426), to me only; nothing is sent. */
export const ROLL_USAGE_LINE: SystemLine = { glyph: "host", actor: null, verb: `Roll a die: /roll, /roll 20 or /roll d20 (${String(DICE_MIN_SIDES)}–${String(DICE_MAX_SIDES)} sides)`, time: null, self: true };

/** What `/hug` or `/highfive` with no name says (OME-1453), to me only; nothing is sent. */
export const HUG_USAGE_LINE: SystemLine = { glyph: "host", actor: null, verb: "Hug someone: /hug <name> or /highfive <name>", time: null, self: true };

/** What `/sit`, "Sit here" or S says with no floor cell under me (OME-1501), to me only; nothing is sent. */
export const SIT_NO_CELL_LINE: SystemLine = { glyph: "host", actor: null, verb: "Step onto the floor to sit there", time: null, self: true };

/** What `/conga` says when the line already has 12 people (OME-1564), to me only; nothing is sent. */
export const CONGA_FULL_LINE: SystemLine = { glyph: "host", actor: null, verb: "The conga line is full (12 people)", time: null, self: true };

/** What `/dance` says while I'm seated (OME-1378), to me only; nothing is sent. */
export const DANCE_SEATED_LINE: SystemLine = { glyph: "host", actor: null, verb: "Stand up to dance", time: null, self: true };

const STICKERS: readonly (readonly [RegExp, EmoteKind])[] = [
  [/<3/, "heart"],
  [/\b(?:lol+|ha(?:ha)+h?)\b/i, "laugh"],
  [/!!/, "exclaim"],
  [/\?\?/, "question"],
  // OME-1547; `\b` keeps each off inside a longer word (`ggplot`, `wowza`, `0xD`).
  [/:\)/, "heart"],
  [/:D\b|\b[xX][dD]\b/, "laugh"],
  [/\bgg\b/i, "cheer"],
  [/\bwow\b/i, "exclaim"],
  [/\b(?:hi|bye) all\b/i, "wave"],
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
