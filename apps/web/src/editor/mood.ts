import type { RoomMood } from "@omega/shared";
import { el } from "../controls/dom";

export interface MoodPicker {
  readonly el: HTMLElement;
  set(mood: RoomMood): void;
}

export function createMoodPicker(_onPick: (mood: RoomMood) => void): MoodPicker {
  return { el: el("div"), set: () => undefined };
}
