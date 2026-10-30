// The generic tier's TV (ADR 0024 §3): a click-to-load card, then one sandboxed iframe. Text only, no third-party request before Load.
import type { UnlockOutcome } from "@omega/shared/extension-bridge";
import type { ExtensionBridge } from "../extension-bridge";
import type { TvGeneric } from "../tv";
import { el } from "./dom";

export interface GenericTv {
  /** Goes in the TV box: the card, then the iframe. */
  readonly screen: HTMLElement;
  /** Goes in the control-bar slot instead of the sync controls: the "not synced" label and the can't-embed hint. */
  readonly strip: HTMLElement;
  /** True once this viewer clicked Load. */
  loaded(): boolean;
  /** ADR 0057: this viewer's frame follows the room (on), doesn't (off), or the extension couldn't attach (failed). */
  setSync(s: "on" | "off" | "failed"): void;
}

/** One per shown generic embed: a new embed gets a new card, so the viewer's choice resets with it. */
export function createGenericTv(frame: TvGeneric, bridge: ExtensionBridge, _onUnlockedLoad?: () => void): GenericTv {
  const screen = el("div", { className: "tv-generic" });
  const card = el("div", { className: "generic-card" }, "generic-card");
  const from = el("p", { className: "generic-from", textContent: "Video from " });
  from.append(el("strong", { textContent: frame.host }));
  const load = el("button", { type: "button", className: "enter", textContent: "Load" }, "generic-load");
  const actions = el("p", { className: "generic-actions" });
  actions.append(load);
  // ADR 0047 §1: we can't see a refusal across origins, so this names no host.
  const extHint = el("p", { className: "generic-note", textContent: "Some hosts only play here with the Omega Share extension." }, "generic-ext-hint");
  const status = el("p", { className: "generic-note", hidden: true }, "generic-unlock-status");
  card.append(from, el("p", { className: "generic-note", textContent: "Not synced: everyone plays it on their own." }), actions, extHint, status);
  screen.append(card);

  const strip = el("div", { className: "generic-strip" });
  const label = el("span", { className: "generic-label", textContent: "Not synced" }, "not-synced");
  // Short enough to show whole in the strip; the tooltip names the host so "this site" can't read as ours.
  const hint = el("span", {
    className: "generic-hint",
    textContent: "Blank/error: host blocks it",
    title: `Blank or an error page? ${frame.host} doesn't allow playing its videos here.`,
    hidden: true,
  }, "generic-hint");
  // With the extension, the hint becomes this after Load (OME-1060): the card's Unlock left with the card.
  const stripUnlock = el("button", {
    type: "button",
    className: "generic-strip-unlock",
    textContent: "Blank/error? Unlock",
    title: `Blank or an error page? Unlock ${frame.host} with the Omega Share extension and reload it.`,
    hidden: true,
  }, "generic-strip-unlock");
  strip.append(label, hint, stripUnlock);

  let loaded = false;
  let present = false;
  const showStrip = (): void => {
    hint.hidden = !loaded || present;
    stripUnlock.hidden = !loaded || !present;
  };
  /** Creates the iframe, or recreates it so its first navigation happens under the extension's rules. */
  const play = (): void => {
    loaded = true;
    // Every attribute is a constant from tv.ts `genericFrame`; src is its parsed url.
    const iframe = el("iframe", { src: frame.src, allow: frame.allow, referrerPolicy: frame.referrerPolicy, title: frame.title }, "shared-video");
    iframe.setAttribute("sandbox", frame.sandbox);
    screen.replaceChildren(iframe);
    showStrip();
  };
  /** Asks the extension to unlock the host from `button`; reloads the frame once unlocked, else calls `failed`. */
  const askUnlock = (button: HTMLButtonElement, failed: (outcome: Exclude<UnlockOutcome, "unlocked">) => void): void => {
    button.disabled = true;
    // A consent tab closed without an answer sends nothing back: coming back to the room lets the viewer ask again.
    window.addEventListener("focus", () => (button.disabled = false), { once: true });
    void bridge.unlock(frame.host).then((outcome) => {
      button.disabled = false;
      if (outcome === "unlocked") play();
      else failed(outcome);
    });
  };
  load.addEventListener("click", () => {
    if (!loaded) play();
  });

  bridge.whenPresent(() => {
    present = true;
    showStrip();
    extHint.hidden = true;
    const unlock = el("button", { type: "button", className: "enter", textContent: "Unlock with extension" }, "generic-unlock");
    actions.append(" ", unlock);
    unlock.addEventListener("click", () => {
      status.hidden = true;
      askUnlock(unlock, (outcome) => {
        status.textContent = outcome === "denied" ? `${frame.host} wasn't unlocked.` : `The extension can't unlock ${frame.host} in this browser.`;
        status.hidden = false;
      });
    });
  });
  stripUnlock.addEventListener("click", () => {
    askUnlock(stripUnlock, (outcome) => {
      if (outcome === "denied") {
        stripUnlock.title = `${frame.host} wasn't unlocked. Click to ask again.`;
        return;
      }
      // The extension can't help in this browser: back to the plain hint.
      present = false;
      showStrip();
    });
  });

  return { screen, strip, loaded: () => loaded, setSync: () => undefined };
}
