// @mentions (OME-1531), client-only: a chat line that names me, as `@name` or as the bare name as a whole word. Nothing
// goes on the wire; the room page highlights the line, rings the speaker's bubble and puts (@) in a hidden tab's title.
import type { Member, MemberId } from "@omega/shared";

// shortcut: the Latin, Greek and Cyrillic lookalikes of TR39 confusables.txt plus 0/1, not the full table, which stays
// server-only (ADR 0023: the web app must not pay its 23 KB). Upgrade if a real name in another script slips past.
const LOOKALIKE: Readonly<Record<string, string>> = {
  "0": "o", "1": "l",
  // Cyrillic
  "А": "A", "В": "B", "Е": "E", "К": "K", "М": "M", "Н": "H", "О": "O", "Р": "P", "С": "C", "Т": "T", "У": "Y", "Х": "X",
  "І": "I", "Ј": "J", "Ѕ": "S", "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ј": "j",
  "ѕ": "s", "ԁ": "d", "ӏ": "l", "һ": "h", "ԛ": "q", "ԝ": "w",
  // Greek
  "Α": "A", "Β": "B", "Ε": "E", "Ζ": "Z", "Η": "H", "Ι": "I", "Κ": "K", "Μ": "M", "Ν": "N", "Ο": "O", "Ρ": "P", "Τ": "T",
  "Υ": "Y", "Χ": "X", "α": "a", "ι": "i", "ν": "v", "ο": "o", "ρ": "p", "υ": "u",
};
const LOOKALIKES = new RegExp(`[${Object.keys(LOOKALIKE).join("")}]`, "gu");

/** Case-, accent-, width- and lookalike-folded: "Zoë", "ZOE", "ｚｏｅ" and Cyrillic "Ζое" are all "zoe". */
export const foldName = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").replace(LOOKALIKES, (c) => LOOKALIKE[c] ?? c).toLowerCase();

const WORD = /[\p{L}\p{N}_]/u;

/** Does `text` name `nickname` as a whole word (`@name` included)? Runs once per chat line, never per frame. */
export function mentions(text: string, nickname: string): boolean {
  const name = foldName(nickname).trim();
  if (name === "") return false;
  const t = foldName(text);
  for (let i = t.indexOf(name); i !== -1; i = t.indexOf(name, i + 1)) {
    if (!WORD.test(t.charAt(i - 1)) && !WORD.test(t.charAt(i + name.length))) return true;
  }
  return false;
}

/** The `@word` the caret ends: where its @ is, and what follows it. */
export interface MentionQuery {
  readonly start: number;
  readonly query: string;
}

/** The @word being typed at `caret`, or null. An @ inside a word (an address) is not one. */
export function mentionQuery(value: string, caret: number): MentionQuery | null {
  const before = value.slice(0, caret);
  const start = before.search(/\S*$/u);
  return before.charAt(start) === "@" ? { start, query: before.slice(start + 1) } : null;
}

/** The completion list's cap; a room holds 25 at most. */
const MAX_OPTIONS = 8;

/** Present members but me whose name starts with `query` (folded), in room order. */
export function mentionOptions(members: readonly Member[], self: MemberId | null, query: string): string[] {
  const want = foldName(query);
  return members.filter((m) => m.id !== self && foldName(m.nickname).startsWith(want)).slice(0, MAX_OPTIONS).map((m) => m.nickname);
}

/** `value` with the @query replaced by `@name` and one space, and where the caret goes. */
export function completeMention(value: string, q: MentionQuery, name: string): { value: string; caret: number } {
  const rest = value.slice(q.start + 1 + q.query.length);
  const insert = `@${name}${rest.startsWith(" ") ? "" : " "}`;
  return { value: value.slice(0, q.start) + insert + rest, caret: q.start + insert.length + (rest.startsWith(" ") ? 1 : 0) };
}
