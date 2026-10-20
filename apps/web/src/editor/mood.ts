// The room mood picker (OME-1502): four radios. The editor puts the pick in the draft; it is saved with the layout.
import { ROOM_MOODS, type RoomMood } from "@omega/shared";
import { el } from "../controls/dom";

const LABELS: Readonly<Record<RoomMood, string>> = { none: "None", warm: "Warm", cool: "Cool", night: "Night" };

export interface MoodPicker {
  readonly el: HTMLElement;
  set(mood: RoomMood): void;
}

export function createMoodPicker(onPick: (mood: RoomMood) => void): MoodPicker {
  const root = el("div", { className: "editor-mood" });
  const group = el("div", { className: "editor-mood-options", role: "radiogroup" });
  group.setAttribute("aria-label", "Room mood");
  const radios = ROOM_MOODS.map((m) => {
    const b = el("button", { type: "button", className: "ui-button secondary", role: "radio", textContent: LABELS[m] }, "editor-mood");
    b.dataset["mood"] = m;
    b.setAttribute("aria-checked", "false");
    b.addEventListener("click", () => {
      onPick(m);
    });
    return b;
  });
  group.append(...radios);
  root.append(el("span", { textContent: "Mood" }), group);
  return {
    el: root,
    set(mood) {
      radios.forEach((b, i) => {
        b.setAttribute("aria-checked", String(ROOM_MOODS[i] === mood));
      });
    },
  };
}
