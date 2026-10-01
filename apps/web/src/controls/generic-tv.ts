// The generic tier's TV (ADR 0024 §3): a click-to-load card, then one sandboxed iframe. Text only, no third-party request before Load.
import type { TvGeneric } from "../tv";
import { el } from "./dom";

export interface GenericTv {
  /** Goes in the TV box: the card, then the iframe. */
  readonly screen: HTMLElement;
  /** Goes in the control-bar slot instead of the sync controls: the "not synced" label and the can't-embed hint. */
  readonly strip: HTMLElement;
  /** True once this viewer clicked Load. */
  loaded(): boolean;
}

/** One per shown generic embed: a new embed gets a new card, so the viewer's choice resets with it. */
export function createGenericTv(frame: TvGeneric): GenericTv {
  const screen = el("div", { className: "tv-generic" });
  const card = el("div", { className: "generic-card" }, "generic-card");
  const from = el("p", { className: "generic-from", textContent: "Video from " });
  from.append(el("strong", { textContent: frame.host }));
  const load = el("button", { type: "button", className: "enter", textContent: "Load" }, "generic-load");
  card.append(from, el("p", { className: "generic-note", textContent: "Not synced: everyone plays it on their own." }), load);
  screen.append(card);

  const strip = el("div", { className: "generic-strip" });
  const label = el("span", { className: "generic-label", textContent: "Not synced" }, "not-synced");
  const hint = el("span", { className: "generic-hint", textContent: "Blank? This site doesn't allow embedding.", hidden: true }, "generic-hint");
  strip.append(label, hint);

  let loaded = false;
  load.addEventListener("click", () => {
    if (loaded) return;
    loaded = true;
    // Every attribute is a constant from tv.ts `genericFrame`; src is its parsed url.
    const iframe = el("iframe", { src: frame.src, allow: frame.allow, referrerPolicy: frame.referrerPolicy, title: frame.title }, "shared-video");
    iframe.setAttribute("sandbox", frame.sandbox);
    screen.replaceChildren(iframe);
    hint.hidden = false;
  });

  return { screen, strip, loaded: () => loaded };
}
