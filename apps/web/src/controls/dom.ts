// DOM for the set (e) playback chrome (assets/README.md "Playback chrome"). Text only: every string goes in via textContent.
import type { Sysline } from "../state";
import type { PlaybackController, PlaybackView } from "./playback";
import { formatClock } from "./sysline";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, testId?: string): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  if (testId !== undefined) e.setAttribute("data-testid", testId);
  return e;
}

const sprite = (name: string): HTMLSpanElement => el("span", { className: `ui-sprite ${name}`, ariaHidden: "true" });

function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

/** A transparent range input laid over the slider art (the art is decoration). */
function range(label: string, testId: string): HTMLInputElement {
  return el("input", { type: "range", min: "0", step: "any", ariaLabel: label }, testId);
}

export interface Widget {
  readonly root: HTMLElement;
  update(v: PlaybackView): void;
}

/** Shared transport for the TV's control-bar slot: chip · play/pause · current · seek · duration. */
export function createTransport(c: PlaybackController): Widget {
  const root = el("div", { className: "ui-transport", role: "group", ariaLabel: "Shared playback: affects everyone" });
  const chip = el("span", { className: "ui-chip shared" });
  chip.append(sprite("ui-glyph-everyone"), "Everyone");
  const icon = sprite("ui-icon-play");
  const key = el("button", { type: "button", className: "ui-button shared icon", ariaLabel: "Play for everyone", disabled: true }, "play-toggle");
  key.append(icon);
  const cur = el("span", { className: "ui-readout", textContent: "0:00" }, "time-current");
  const dur = el("span", { className: "ui-readout", textContent: "--:--" }, "time-duration");
  const seek = el("div", { className: "ui-seek is-disabled" });
  const input = range("Seek for everyone", "seek");
  input.disabled = true;
  seek.append(el("div", { className: "ui-seek-fill" }), sprite("ui-seek-head ui-seek-head-idle"), input);
  root.append(chip, key, cur, seek, dur);

  let dragging = false;
  let last: PlaybackView | null = null;
  // Writes are guarded: the controller emits at 4 Hz while playing, and each style/paint invalidation of the
  // shelf costs frames (perf budget). The bar and readout move in whole seconds; 1 s is < 1 px on a 10 min video.
  let shownSecond = -1;
  key.addEventListener("click", () => {
    c.togglePlay();
  });
  input.addEventListener("input", () => {
    dragging = true;
    const d = last?.duration ?? 0;
    const p = Number(input.value);
    setText(cur, formatClock(p));
    seek.style.setProperty("--pos", String(d > 0 ? p / d : 0));
  });
  input.addEventListener("change", () => {
    dragging = false;
    shownSecond = -1;
    c.seek(Number(input.value));
  });
  // Released on the same value or cancelled: no `change`, so don't stay frozen in "dragging". Deferred so a
  // `change` from the same release still reads the dragged value first.
  const endDrag = (): void => {
    setTimeout(() => {
      dragging = false;
      shownSecond = -1;
    }, 0);
  };
  for (const type of ["pointerup", "pointercancel", "blur"]) input.addEventListener(type, endDrag);

  return {
    root,
    update(v) {
      const prev = last;
      last = v;
      if (prev?.playing !== v.playing) {
        key.ariaLabel = v.playing ? "Pause for everyone" : "Play for everyone";
        icon.className = `ui-sprite ${v.playing ? "ui-icon-pause" : "ui-icon-play"}`;
      }
      const seekable = v.canControl && v.duration > 0;
      if (prev?.canControl !== v.canControl) key.disabled = !v.canControl;
      if (prev?.canControl !== v.canControl || prev.duration !== v.duration) {
        input.disabled = !seekable;
        seek.classList.toggle("is-disabled", !seekable);
        input.max = String(v.duration);
        setText(dur, v.duration > 0 ? formatClock(v.duration) : "--:--");
        shownSecond = -1;
      }
      if (dragging) return;
      const second = Math.floor(v.position);
      if (second === shownSecond) return;
      shownSecond = second;
      setText(cur, formatClock(v.position));
      input.value = String(second);
      seek.style.setProperty("--pos", String(v.duration > 0 ? Math.min(1, second / v.duration) : 0));
    },
  };
}

/** Personal controls, below the stage and never on the TV: volume pod, Unmute, and my own catching-up notice. */
export function createPersonal(c: PlaybackController): Widget {
  const root = el("div", { className: "room-bar" });
  const pod = el("div", { className: "ui-volume", role: "group", ariaLabel: "Your volume: only you hear this" });
  const chip = el("span", { className: "ui-chip self" });
  chip.append(sprite("ui-glyph-you"), "Only you");
  const icon = sprite("ui-icon-sound");
  const mute = el("button", { type: "button", className: "ui-button self icon", ariaLabel: "Mute, only for you", ariaPressed: "false" }, "mute-toggle");
  mute.append(icon);
  const track = el("div", { className: "ui-vol-track" });
  const input = range("Your volume", "volume");
  input.max = "100";
  input.step = "1";
  track.append(el("div", { className: "ui-vol-fill" }), sprite("ui-vol-knob ui-volume-knob-idle"), input);
  pod.append(chip, mute, track);

  const unmute = el("button", { type: "button", className: "ui-button", hidden: true }, "unmute-button");
  unmute.append(sprite("ui-icon-sound"), "Unmute");
  const notice = el("p", { className: "ui-panel catching-notice", role: "status", hidden: true }, "catching-notice");
  notice.append(sprite("ui-catchup"), "You're catching up: the room kept playing…");
  root.append(pod, unmute, notice);

  mute.addEventListener("click", () => {
    c.toggleMute();
  });
  input.addEventListener("input", () => {
    c.setVolume(Number(input.value));
  });
  unmute.addEventListener("click", () => {
    c.unmute();
  });

  let last: PlaybackView | null = null;
  return {
    root,
    update(v) {
      const prev = last;
      last = v;
      if (prev !== null && prev.muted === v.muted && prev.needsUnmute === v.needsUnmute && prev.volume === v.volume && prev.catching === v.catching) return;
      const silent = v.muted || v.needsUnmute;
      mute.ariaPressed = String(silent);
      mute.ariaLabel = silent ? "Unmute, only for you" : "Mute, only for you";
      icon.className = `ui-sprite ${silent ? "ui-icon-muted" : "ui-icon-sound"}`;
      pod.classList.toggle("is-muted", silent);
      const shown = v.muted ? 0 : v.volume;
      if (document.activeElement !== input) input.value = String(shown);
      track.style.setProperty("--vol", String(shown / 100));
      unmute.hidden = !v.needsUnmute;
      notice.hidden = !v.catching;
    },
  };
}

function syslineEl(l: Sysline): HTMLElement {
  const p = el("p", { className: "ui-sysline" }, "system-line");
  p.append(sprite(`ui-glyph-${l.glyph}`));
  if (l.actor !== null) p.append(el("b", { textContent: l.actor }), ` ${l.verb}`);
  else p.append(l.verb);
  if (l.time !== null) p.append(" ", el("time", { textContent: l.time }));
  return p;
}

/** Keep the caption rail in step with the state's lines (keyed by rev; new ones only ever append). */
export function renderSyslines(rail: HTMLElement, lines: readonly Sysline[], els: Map<number, HTMLElement>): void {
  const live = new Set<number>();
  for (const l of lines) live.add(l.id);
  for (const [id, e] of els) {
    if (live.has(id)) continue;
    e.remove();
    els.delete(id);
  }
  for (const l of lines) {
    if (els.has(l.id)) continue;
    const e = syslineEl(l);
    els.set(l.id, e);
    rail.append(e);
  }
}
