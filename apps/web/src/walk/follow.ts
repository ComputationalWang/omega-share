// Follow (OME-1389): while I follow someone, each of their `walked` sends me a Walk over beside them.
import type { MemberId } from "@omega/shared";
import type { ViewState } from "../state";

/** What one state change means for following `target`: walk over again, stop, or nothing. */
export function followStep(_prev: ViewState, _next: ViewState, _target: MemberId): "walk" | "stop" | null {
  return null;
}
