// Which of the state's bubbles the floats haven't had yet (OME-809). The state keeps a speaker's last 2 lines, each
// with its own id, and the stage renders at most once a frame, so several new lines can arrive between two renders:
// each id is handed to the floats once, oldest first. Ids, not objects: a pop-out window parses fresh objects every
// update. It remembers only the ids still in the state, so it never holds more than the state does.
import type { Bubble } from "../state";

export interface Handoff {
  /** Calls `say` for each bubble not yet handed over; one it returns false for (no position yet) is offered again. */
  hand(bubbles: readonly Bubble[], say: (b: Bubble) => boolean): void;
  size(): number;
}

export function createHandoff(): Handoff {
  const handed = new Set<number>();
  return {
    hand(bubbles, say) {
      for (const id of handed) if (!bubbles.some((b) => b.id === id)) handed.delete(id);
      for (const b of bubbles) if (!handed.has(b.id) && say(b)) handed.add(b.id);
    },
    size: () => handed.size,
  };
}
