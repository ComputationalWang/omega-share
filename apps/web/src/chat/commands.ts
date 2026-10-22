// The command table (OME-1586): the one list the palette, the slash parser and /help read.
import type { EmoteKind } from "@omega/shared";
import { EMOTE_LABELS, PICKER_KINDS } from "../emote/emotes";

/** A slash command: its word, what /help says, and what the palette does with `text` (sends it, or fills the field). */
export interface SlashEntry {
  readonly section: "emotes" | "fun";
  readonly name: string;
  readonly aliases: readonly string[];
  readonly emote?: EmoteKind;
  readonly label: string;
  readonly hint: string;
  readonly help: string;
  readonly does: "run" | "fill";
  readonly text: string;
}

/** A move: a gesture, not a command; the palette only explains it. */
export interface MoveEntry {
  readonly section: "moves";
  readonly label: string;
  readonly hint: string;
}

export type Command = SlashEntry | MoveEntry;

/** Fun aliases for the emotes (OME-1547): `/lol` is `/laugh`, and so on. */
const ALIASES: Readonly<Partial<Record<EmoteKind, readonly string[]>>> = { heart: ["love"], laugh: ["lol"], question: ["hmm"], exclaim: ["wow"], wave: ["hi", "bye"], cheer: ["yay"], yawn: ["sleepy"] };

const emote = (kind: EmoteKind): SlashEntry => {
  const aliases = ALIASES[kind] ?? [];
  const alsoSaid = aliases.length === 0 ? "" : ` (${aliases.map((a) => `/${a}`).join(" ")})`;
  return { section: "emotes", name: kind, aliases, emote: kind, label: EMOTE_LABELS[kind], hint: `/${kind}${alsoSaid}`, help: `/${kind}${alsoSaid}`, does: "run", text: `/${kind}` };
};

const fun = (name: string, does: "run" | "fill", text: string, help: string, label: string, hint: string): SlashEntry => ({ section: "fun", name, aliases: [], label, hint, help, does, text });

const move = (label: string, hint: string): MoveEntry => ({ section: "moves", label, hint });

/** Order is the palette's and /help's. Dance is a picker emote (keys 1–9) but reads as fun here. */
export const COMMANDS: readonly Command[] = [
  ...PICKER_KINDS.filter((k) => k !== "dance").map(emote),
  { ...fun("dance", "run", "/dance", "/dance", "Dance", "Dance on the spot (standing only)"), emote: "dance" },
  fun("roll", "run", "/roll", "/roll [sides]", "Roll a die", "A d6 for everyone; /roll 20 for a d20"),
  fun("poll", "fill", "/poll Question? A | B", "/poll Question? A | B", "Poll", "Ask the room; options split on |"),
  fun("conga", "run", "/conga", "/conga", "Conga", "Join the conga line behind the last dancer"),
  fun("stop", "run", "/stop", "/stop", "Stop", "Leave the conga line or stop following"),
  fun("snap", "run", "/snap", "/snap", "Snap", "Save a photo of the room"),
  fun("sit", "run", "/sit", "/sit", "Sit", "Sit on the floor where you stand, or get up"),
  fun("me", "fill", "/me ", "/me <action>", "Action", "Say what you do, in italics"),
  fun("think", "fill", "/think ", "/think <thought>", "Think", "A thought bubble over your head"),
  fun("hug", "fill", "/hug @", "/hug <name>", "Hug", "Walk over and hug someone"),
  fun("highfive", "fill", "/highfive @", "/highfive <name>", "High five", "Walk over and high-five someone"),
  fun("pet", "run", "/pet", "/pet", "Pet the cat", "Walk over and pet the room cat"),
  fun("help", "run", "/help", "/help", "Help", "List these commands in the chat"),
  move("Walk", "Click or tap the floor to walk there."),
  move("Jog", "Shift and the arrows, or double-click the floor, to jog."),
  move("Follow", "Click someone's name tag, then Follow, to walk behind them."),
  move("Walk over", "Click someone's name tag, then Walk over, to stand beside them."),
  move("Teleport pads", "Stand on one pad to come out at the other."),
  move("Doors", "Stand in front of a door, then Go, to visit that room."),
];

/** The Dank Dungeon's pair (OME-1672): in a room whose layout has `pairs: true` only, nowhere else (not /help, not the palette). */
const PAIR_COMMANDS: readonly SlashEntry[] = [
  fun("thrust", "run", "/thrust", "/thrust", "Thrust", "Invite someone to pair up; they answer with /bendover"),
  fun("bendover", "run", "/bendover", "/bendover", "Bend over", "Invite someone to pair up; they answer with /thrust"),
];

/** Before /help, so /help stays last among the fun ones. */
const AT_HELP = COMMANDS.findIndex((c) => c.section !== "moves" && c.name === "help");
const WITH_PAIRS: readonly Command[] = [...COMMANDS.slice(0, AT_HELP), ...PAIR_COMMANDS, ...COMMANDS.slice(AT_HELP)];

/** The table a room shows: the base one, plus the pair commands where its layout has `pairs`. */
export const commandsFor = (pairs: boolean): readonly Command[] => (pairs ? WITH_PAIRS : COMMANDS);
