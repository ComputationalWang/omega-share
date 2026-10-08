import { coolingDown, type Refusal, type ViewState } from "../state";

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
  readonly placeholder: string;
}

const OPEN: ChatView = { cooling: false, placeholder: "Say something…" };
const COOLING: ChatView = { cooling: true, placeholder: "Slow down a moment…" };

export function chatView(state: ViewState, now: number): ChatView {
  return coolingDown(state, now) ? COOLING : OPEN;
}
