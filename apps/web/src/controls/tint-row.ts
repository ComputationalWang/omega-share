// The shirt tint row (OME-1352, ADR 0053): six swatches in a radiogroup, named for screen readers, one tab stop, arrows
// move the choice (WAI-ARIA radio pattern, as the avatar picker). The landing ships it as static markup under the
// avatar picker (no layout shift, index.html); the room builds the same markup. Plain DOM: the landing entry stays tiny.
import { TINT_COUNT, type Tint } from "@omega/shared";

export interface TintRow {
  /** Label and colour the swatches with an avatar's ramps and check `tint`. Picks nothing. */
  show(tints: readonly { readonly id: string; readonly colors: readonly string[] }[], tint: Tint): void;
}

/** The row's markup (the landing's is the same, in index.html). */
export function buildTintRow(): HTMLElement {
  const group = document.createElement("div");
  group.className = "tints";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", "Shirt colour");
  for (let t = 0; t < TINT_COUNT; t++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tint";
    b.setAttribute("role", "radio");
    b.dataset["tint"] = String(t);
    b.dataset["testid"] = "tint-option";
    group.append(b);
  }
  return group;
}

const KEYS: Readonly<Record<string, (i: number, n: number) => number>> = {
  ArrowRight: (i, n) => (i + 1) % n,
  ArrowDown: (i, n) => (i + 1) % n,
  ArrowLeft: (i, n) => (i + n - 1) % n,
  ArrowUp: (i, n) => (i + n - 1) % n,
  Home: () => 0,
  End: (_, n) => n - 1,
};

/** Wires a row's swatches; `onPick` gets a tint other than the checked one. */
export function bindTintRow(group: HTMLElement, onPick: (t: Tint) => void): TintRow {
  const swatches = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  let checked = 0;
  const check = (t: number): void => {
    checked = t;
    swatches.forEach((b, i) => {
      b.setAttribute("aria-checked", String(i === t));
      b.tabIndex = i === t ? 0 : -1;
    });
  };
  const pick = (t: number): void => {
    if (t === checked) return;
    check(t);
    onPick(t);
  };
  swatches.forEach((b, i) => {
    b.addEventListener("click", () => {
      pick(i);
    });
  });
  group.addEventListener("keydown", (ev) => {
    const step = KEYS[ev.key];
    if (step === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    const next = step(checked, swatches.length);
    pick(next);
    swatches[next]?.focus();
  });
  return {
    show(tints, tint) {
      swatches.forEach((b, i) => {
        const ramp = tints[i];
        if (ramp === undefined) return;
        b.setAttribute("aria-label", ramp.id.charAt(0).toUpperCase() + ramp.id.slice(1));
        b.style.setProperty("--swatch", ramp.colors[1] ?? "");
      });
      check(tint);
    },
  };
}
