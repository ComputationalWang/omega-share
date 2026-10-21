// The command table (OME-1586): the one list the palette, the slash parser and /help read.
import type { EmoteKind } from "@omega/shared";

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

export const COMMANDS: readonly Command[] = [];
