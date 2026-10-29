// The room sounds' mute and volume in the room bar (OME-1968), beside Leave: the Help dialog's Sound setting (OME-1638)
// where people look for it. It drives the engine's one master gain and keeps no state of its own; `sync` mirrors the
// engine after a change made elsewhere. Never the video's volume: that's the player's own (createPersonal in dom.ts).
import type { SoundSetting } from "../help/dialog";
import { el, sprite } from "./dom";

export interface SoundKey {
  readonly root: HTMLElement;
  /** Shows the engine's setting; hidden while it isn't loaded. */
  sync(): void;
}

export function createSoundKey(sound: () => SoundSetting | null): SoundKey {
  const root = el("div", { className: "sound-key", hidden: true });
  // Attributes, not the ARIA reflection properties: the same in every engine (and in happy-dom).
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", "Room sounds");
  const icon = sprite("ui-icon-sound");
  const toggle = el("button", { type: "button", className: "ui-button self icon", title: "Room sounds" }, "sound-key");
  toggle.append(icon);
  const slider = el("input", { type: "range", min: "0", max: "100", step: "5" }, "sound-key-volume");
  slider.setAttribute("aria-label", "Room sounds volume");
  root.append(toggle, slider);

  /** What the DOM shows: -1 hidden, else the volume, plus 2 when muted. room.ts syncs on every render, so an unchanged one writes nothing. */
  let shown = -1;
  const sync = (): void => {
    const s = sound();
    const now = s === null ? -1 : s.volume() + (s.muted() ? 2 : 0);
    if (now === shown) return;
    shown = now;
    root.hidden = s === null;
    if (s === null) return;
    const muted = s.muted();
    toggle.setAttribute("aria-pressed", String(muted));
    toggle.setAttribute("aria-label", muted ? "Unmute room sounds" : "Mute room sounds");
    icon.className = `ui-sprite ${muted ? "ui-icon-muted" : "ui-icon-sound"}`;
    if (document.activeElement !== slider) slider.value = String(Math.round(s.volume() * 100));
  };

  toggle.addEventListener("click", () => {
    const s = sound();
    s?.setMuted(!s.muted());
    sync();
  });
  slider.addEventListener("input", () => {
    const s = sound();
    if (s === null) return;
    // Turning it up is asking to hear it.
    if (s.muted()) s.setMuted(false);
    s.setVolume(Number(slider.value) / 100);
    sync();
  });
  return { root, sync };
}
