// Emotes (OME-415): the picker's order and shortcuts, and the local bucket that keeps us under the server's emote limit.
import { EMOTE_BURST, EMOTE_REFILL_MS, type EmoteKind } from "@omega/shared";

/** Set (i)'s picker: the five stickers in the motion atlas's order, the wave, set (p)'s cheer and yawn, then dance (OME-1378). Keys 1–9 pick them in this order. */
export const PICKER_KINDS: readonly EmoteKind[] = ["heart", "laugh", "question", "exclaim", "clap", "wave", "cheer", "yawn", "dance"];

/** What the picker says for each (the atlas's `meta.omega` labels). */
export const EMOTE_LABELS: Readonly<Record<EmoteKind, string>> = { heart: "Heart", laugh: "Laugh", question: "Question", exclaim: "Surprise", clap: "Clap", wave: "Wave", cheer: "Cheer", yawn: "Yawn", dance: "Dance" };

/** The UI sprite class that shows `kind` in the picker and as its badge; dance has no art of its own (OME-1378), so it borrows the sound icon. */
export const emoteIcon = (kind: EmoteKind): string => (kind === "dance" ? "ui-icon-sound" : `ui-emote-pick-${kind}`);

/** The room sound each emote plays (OME-1969): its own recipe in assets/sound/recipes.json, so they're told apart by ear. */
export const EMOTE_SOUNDS: Readonly<Record<EmoteKind, string>> = { heart: "emote.heart", laugh: "emote.laugh", question: "emote.question", exclaim: "emote.exclaim", clap: "emote.clap", wave: "emote.wave", cheer: "emote.cheer", yawn: "emote.yawn", dance: "emote.dance" };

/** The emote a key (KeyboardEvent.key) picks, or null. */
export function kindForKey(key: string): EmoteKind | null {
  if (key.length !== 1) return null;
  return PICKER_KINDS[key.charCodeAt(0) - 49] ?? null;
}

/**
 * Our refill runs this much slower than the server's (C2), so network jitter that bunches two emotes together on the
 * way never makes the server drop one: its `rate_limited` would cool chat too.
 */
export const EMOTE_MARGIN_MS = 50;
const REFILL_MS = EMOTE_REFILL_MS + EMOTE_MARGIN_MS;

export interface EmoteBucket {
  /** Takes a token if one is left at `now`. */
  take(now: number): boolean;
  /** When the next token is there (`now` or earlier if one is left). */
  readyAt(now: number): number;
}

export function createEmoteBucket(now: number): EmoteBucket {
  // Credit in ms of refill time (a token is REFILL_MS of it), so whole-ms clocks never round a token away.
  const full = EMOTE_BURST * REFILL_MS;
  let credit = full;
  let last = now;
  const refill = (t: number): void => {
    if (t <= last) return;
    credit = Math.min(full, credit + t - last);
    last = t;
  };
  return {
    take(t) {
      refill(t);
      if (credit < REFILL_MS) return false;
      credit -= REFILL_MS;
      return true;
    },
    readyAt(t) {
      refill(t);
      return credit >= REFILL_MS ? t : t + REFILL_MS - credit;
    },
  };
}
