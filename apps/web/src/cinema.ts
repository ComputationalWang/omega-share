// Cinema dim (OME-1406): while the video plays, one fixed rgba layer over the room's canvas (under the tags, bubbles and
// controls) dims the room so the screen stands out. It lifts on pause, on end and while the editor is open. Only a class
// flips on playback or editor changes; the fade is CSS (room.css). The setting is this device's, never on the wire.
import type { RoomMood } from "@omega/shared";
import { el } from "./controls/dom";

export const CINEMA_KEY = "omega.cinema";

/** A `localStorage`-like store; its methods may throw (blocked storage). */
export interface CinemaStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CinemaDim {
  /** The layer: the stage puts it right over the canvas. */
  readonly el: HTMLDivElement;
  on(): boolean;
  set(on: boolean): void;
  update(playing: boolean, editing: boolean): void;
  mood(mood: RoomMood): void;
}

export function createCinemaDim(store: CinemaStore): CinemaDim {
  const layer = el("div", { className: "cinema-dim" });
  layer.setAttribute("aria-hidden", "true");
  // localStorage is untrusted: only exactly "off" turns it off; anything else (or blocked storage) is the default, on.
  let enabled = true;
  try {
    enabled = store.getItem(CINEMA_KEY) !== "off";
  } catch {
    // Storage blocked: the default.
  }
  let playing = false;
  let editing = false;
  const render = (): void => {
    layer.classList.toggle("is-on", enabled && playing && !editing);
  };
  return {
    el: layer,
    on: () => enabled,
    set(on) {
      enabled = on;
      render();
      try {
        store.setItem(CINEMA_KEY, on ? "on" : "off");
      } catch {
        // Storage off (private mode): the choice lasts for this page only.
      }
    },
    update(p, e) {
      playing = p;
      editing = e;
      render();
    },
    mood: () => undefined,
  };
}
