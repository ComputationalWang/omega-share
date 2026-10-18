// "Go to <room> · Stay" (OME-1425): the chip over the room window while I stand in front of a door.
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

// eslint-disable-next-line @typescript-eslint/no-unused-vars -- red stub
export function createDoorChip(o: DoorChipOptions): DoorChip {
  return { root: el("div", { hidden: true }, "door-chip"), at: () => undefined };
}
