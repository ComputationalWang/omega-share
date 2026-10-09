// DOM for the set (e) playback chrome (assets/README.md "Playback chrome"). Text only: every string goes in via textContent.
import type { Provider } from "@omega/shared";
import type { Sysline } from "../state";
import type { PlaybackController, PlaybackView } from "./playback";
import { formatClock, type SystemLine } from "./sysline";

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, testId?: string): HTMLElementTagNameMap[K] {
  const e = Object.assign(document.createElement(tag), props);
  if (testId !== undefined) e.setAttribute("data-testid", testId);
  return e;
}

export const sprite = (name: string): HTMLSpanElement => el("span", { className: `ui-sprite ${name}`, ariaHidden: "true" });

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

/** What a held shared key says (ADR 0030): the room's owner took the remote. */
const HELD_LABEL = "Only the host controls playback";

/** Plain system-font names for the TV's nameplate (assets/README.md "Provider plate"): never a logo. */
const PROVIDER_NAMES: Readonly<Record<Provider, string>> = { youtube: "YouTube", twitch: "Twitch", vimeo: "Vimeo" };

/**
 * Shared transport for the TV's control-bar slot: chip · play/pause · current · seek · duration · [hint] · plate.
 * Live (assets/README.md "Live transport"): chip · play/pause · LIVE pill · note · back-to-live · plate; no seek.
 */
export function createTransport(c: Pick<PlaybackController, "togglePlay" | "seek">): Widget {
  const root = el("div", { className: "ui-transport", role: "group", ariaLabel: "Shared playback: affects everyone" });
  const chip = el("span", { className: "ui-chip shared" });
  const chipGlyph = sprite("ui-glyph-everyone");
  chip.append(chipGlyph, "Everyone");
  const icon = sprite("ui-icon-play");
  const key = el("button", { type: "button", className: "ui-button shared icon", ariaLabel: "Play for everyone", disabled: true }, "play-toggle");
  key.append(icon);
  const cur = el("span", { className: "ui-readout", textContent: "0:00" }, "time-current");
  const dur = el("span", { className: "ui-readout", textContent: "--:--" }, "time-duration");
  const seek = el("div", { className: "ui-seek is-disabled" });
  const input = range("Seek for everyone", "seek");
  input.disabled = true;
  seek.append(el("div", { className: "ui-seek-fill" }), sprite("ui-seek-head ui-seek-head-idle"), input);
  const pill = el("span", { className: "ui-live", hidden: true }, "live-pill");
  pill.append(sprite("ui-onair"), "Live");
  const note = el("span", { className: "ui-live-note", textContent: "Live: everyone watches the same moment", hidden: true });
  const toLive = el("button", { type: "button", className: "ui-button shared icon", ariaLabel: "Back to live for everyone", disabled: true, hidden: true }, "to-live");
  const toLiveIcon = sprite("ui-icon-tolive");
  toLive.append(toLiveIcon);
  const hint = el("span", { className: "ui-hint", title: "This player can't change its speed, so it keeps in sync by skipping", hidden: true }, "seek-only-hint");
  hint.append(sprite("ui-glyph-hop"), el("span", { className: "ui-hint-text", textContent: "syncs by skipping" }));
  const plateGlyph = sprite("ui-glyph-src-video");
  const plateName = el("span", { className: "ui-plate-name" });
  const plate = el("span", { className: "ui-plate", hidden: true }, "provider-plate");
  plate.append(plateGlyph, plateName);
  root.append(chip, key, cur, seek, dur, pill, note, toLive, hint, plate);

  let dragging = false;
  let last: PlaybackView | null = null;
  // Writes are guarded: the controller emits at 4 Hz while playing, and each style/paint invalidation of the
  // shelf costs frames (perf budget). The bar and readout move in whole seconds; 1 s is < 1 px on a 10 min video.
  let shownSecond = -1;
  key.addEventListener("click", () => {
    if (last?.held !== true) c.togglePlay();
  });
  // Resuming a live stream is the jump to the live edge; enabled only while the room is paused.
  toLive.addEventListener("click", () => {
    if (last?.playing === false && !last.held) c.togglePlay();
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
      if (prev?.provider !== v.provider || prev.live !== v.live || prev.seekOnly !== v.seekOnly) {
        for (const e of [cur, seek, dur]) e.hidden = v.live;
        for (const e of [pill, note, toLive]) e.hidden = !v.live;
        hint.hidden = !v.seekOnly;
        plate.hidden = v.provider === null;
        const name = v.provider === null ? "" : PROVIDER_NAMES[v.provider];
        setText(plateName, name);
        plate.title = name;
        plate.ariaLabel = name;
        // By content kind, not provider: a Twitch VOD is on-demand video.
        plateGlyph.className = `ui-sprite ${v.live ? "ui-glyph-src-live" : "ui-glyph-src-video"}`;
      }
      if (prev?.policy !== v.policy) {
        // Owner-only (ADR 0030, set j): the chip says who holds the remote, for the host too.
        const host = v.policy === "owner";
        chipGlyph.className = `ui-sprite ${host ? "ui-glyph-host" : "ui-glyph-everyone"}`;
        chip.lastChild?.replaceWith(host ? "Host" : "Everyone");
      }
      if (prev?.playing !== v.playing || prev.live !== v.live || prev.held !== v.held) {
        // Held keys sink into the shelf: still focusable (aria-disabled), saying why, the icon in its off tone.
        const off = v.held ? "-off" : "";
        key.ariaLabel = v.held ? HELD_LABEL : v.playing ? "Pause for everyone" : "Play for everyone";
        icon.className = `ui-sprite ${v.playing ? "ui-icon-pause" : "ui-icon-play"}${off}`;
        toLiveIcon.className = `ui-sprite ui-icon-tolive${off}`;
        toLive.ariaLabel = v.held ? HELD_LABEL : "Back to live for everyone";
        for (const b of [key, toLive]) {
          b.classList.toggle("is-held", v.held);
          if (v.held) b.setAttribute("aria-disabled", "true");
          else b.removeAttribute("aria-disabled");
        }
        root.title = v.held ? HELD_LABEL : "";
        pill.classList.toggle("is-behind", !v.playing);
      }
      if (prev?.canControl !== v.canControl || prev.playing !== v.playing || prev.held !== v.held) toLive.disabled = !v.held && (!v.canControl || v.playing);
      const seekable = v.canControl && v.duration > 0;
      if (prev?.canControl !== v.canControl || prev.held !== v.held) key.disabled = !v.canControl && !v.held;
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

/**
 * Personal controls, never on the TV: the volume `pod` (the room puts it in the TV's shelf, right under the picture,
 * OME-642), and in `root` Unmute and my own catching-up notice.
 */
export function createPersonal(c: PlaybackController): Widget & { readonly pod: HTMLElement } {
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
  root.append(unmute, notice);

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
    pod,
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

/** One system line as DOM: glyph, actor in <b>, time in <time>. The caption rail and the chat log (chat/log.ts) share it. */
export function syslineEl(l: SystemLine): HTMLElement {
  // Only-you lines (my own mute) wear set (j)'s mustard bar.
  const p = el("p", { className: l.self === true ? "ui-sysline self" : "ui-sysline" }, "system-line");
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
