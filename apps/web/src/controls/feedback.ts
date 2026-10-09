import { coolingDown, isMuted, type Refusal, type ViewState } from "../state";

// Placeholder copy for the M3 safety states until the set (f) chrome is wired (OME-193). Text only: it goes
// through textContent, like every string on the page.

export interface RefusalCard {
  readonly title: string;
  readonly body: string;
  /** Label of the link back to the landing, where the user can change the name or just retry. */
  readonly action: string;
}

/** The card that replaces the room when the server refused our join (ADR 0016 §4). */
export function refusalCard(r: Refusal): RefusalCard {
  switch (r) {
    case "nickname_taken":
      return {
        title: "That name is taken",
        body: "Someone in this room already uses that name, or one that looks the same. Pick another name to join.",
        action: "Pick another name",
      };
    case "too_many_members":
      return {
        title: "Too many people from your network",
        body: "This room already has as many people from your network as it allows. Try again later, or join from another connection.",
        action: "Try again",
      };
    case "invite_required":
      return {
        title: "This room is private",
        body: "You need an invite link to join it. Ask someone in the room to send you theirs.",
        action: "Try again",
      };
  }
}

export interface ChatView {
  /** The server said `rate_limited`: hold chat until its `retryAfterMs` is up. */
  readonly cooling: boolean;
  /** The owner muted my chat (ADR 0030): the field is a read-only well that says so, and Send is held. */
  readonly muted: boolean;
  readonly placeholder: string;
}

const OPEN: ChatView = { cooling: false, muted: false, placeholder: "Say something…" };
const COOLING: ChatView = { cooling: true, muted: false, placeholder: "Slow down a moment…" };
const MUTED: ChatView = { cooling: true, muted: true, placeholder: "The host muted your chat" };

export function chatView(state: ViewState, now: number): ChatView {
  if (state.self !== null && isMuted(state, state.self)) return MUTED;
  return coolingDown(state, now) ? COOLING : OPEN;
}

export interface KickedCard {
  readonly title: string;
  readonly body: string;
  /** The Rejoin key's words: it waits out the cooldown, then turns into a plain key. */
  readonly rejoin: string;
  /** The cooldown is over: Rejoin may reload the room. */
  readonly ready: boolean;
  /** When the words next change (the minute count), ms; null once ready. */
  readonly nextChangeMs: number | null;
}

const MINUTE_MS = 60_000;

/** The card that replaces the room after a kick (4005, ADR 0030 §2). `until` and `now` are client ms. */
export function kickedCard(until: number, now: number): KickedCard {
  const title = "You were removed from this room";
  const left = until - now;
  if (left <= 0) return { title, body: "The wait is over. You can go back in if you like.", rejoin: "Rejoin", ready: true, nextChangeMs: null };
  const minutes = Math.ceil(left / MINUTE_MS);
  return {
    title,
    body: `The host asked you to leave. You can come back in ${String(minutes)} ${minutes === 1 ? "minute" : "minutes"}.`,
    rejoin: `Rejoin in ${String(minutes)} min`,
    ready: false,
    nextChangeMs: left - (minutes - 1) * MINUTE_MS,
  };
}
