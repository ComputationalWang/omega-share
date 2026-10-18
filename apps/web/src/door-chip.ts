// "Go to <room> · Stay" (OME-1425): the chip over the room window while I stand in front of a door. Nothing happens by
// itself: Go leaves for the room, Stay hides the chip until I have left the cell and arrived again. Titles go in as text.
import type { RoomId } from "@omega/shared";
import { el } from "./controls/dom";

export interface DoorChipOptions {
  /** The saved title of a room this browser knows, or null. */
  readonly titleOf: (id: RoomId) => string | null;
  /** Leave for `/r/<id>`. */
  readonly go: (path: string) => void;
}

export interface DoorChip {
  readonly root: HTMLElement;
  /** Where I stand now: the room of the door in front of me, or null. Called when my cell changes, never per frame. */
  at(target: RoomId | null): void;
}

export function createDoorChip(o: DoorChipOptions): DoorChip {
  const root = el("div", { className: "ui-chip door-chip", role: "status", hidden: true }, "door-chip");
  const goKey = el("button", { type: "button", className: "ui-button secondary" }, "door-go");
  const stayKey = el("button", { type: "button", className: "ui-button secondary", textContent: "Stay" }, "door-stay");
  root.append(goKey, " · ", stayKey);
  /** The door I stand in front of; a repeat of it (Stay, then another render) changes nothing. */
  let current: RoomId | null = null;
  goKey.addEventListener("click", () => {
    if (current !== null) o.go(`/r/${current}`);
  });
  stayKey.addEventListener("click", () => {
    root.hidden = true;
  });
  return {
    root,
    at(target) {
      if (target === current) return;
      current = target;
      root.hidden = target === null;
      if (target !== null) goKey.textContent = `Go to ${o.titleOf(target) ?? "another room"}`;
    },
  };
}
