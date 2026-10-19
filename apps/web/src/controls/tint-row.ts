// The shirt tint row (OME-1352, ADR 0053): six swatches in a radiogroup, named for screen readers, one tab stop, arrows
// move the choice (WAI-ARIA radio pattern, as the avatar picker). The landing ships it as static markup under the
// avatar picker (no layout shift, index.html); the room builds the same markup. Plain DOM: the landing entry stays tiny.
import { TINT_COUNT, type Tint } from "@omega/shared";

export interface TintRow {
  /** Label and colour the swatches with an avatar's ramps and check `tint`. Picks nothing. */
  show(tints: readonly { readonly id: string; readonly colors: readonly string[] }[], tint: Tint): void;
}

/** The row's markup (the landing's is the same, in index.html). The hair row (OME-1438) is the same row, named for hair. */
export function buildTintRow(label = "Shirt colour", testid = "tint-option"): HTMLElement {
  const group = document.createElement("div");
  group.className = "tints";
  group.setAttribute("role", "radiogroup");
  group.setAttribute("aria-label", label);
  for (let t = 0; t < TINT_COUNT; t++) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tint";
    b.setAttribute("role", "radio");
    b.dataset["tint"] = String(t);
    b.dataset["testid"] = testid;
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

export interface RadioRow {
  /** Check option `i` (the one tab stop). Picks nothing. */
  check(i: number): void;
}

/** Wires a radiogroup's options (the tint and accessory rows); `onPick` gets an option other than the checked one. */
export function bindRadioRow(group: HTMLElement, onPick: (i: number) => void): RadioRow {
  const options = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  let checked = 0;
  const check = (t: number): void => {
    checked = t;
    options.forEach((b, i) => {
      b.setAttribute("aria-checked", String(i === t));
      b.tabIndex = i === t ? 0 : -1;
    });
  };
  const pick = (t: number): void => {
    if (t === checked) return;
    check(t);
    onPick(t);
  };
  options.forEach((b, i) => {
    b.addEventListener("click", () => {
      pick(i);
    });
  });
  group.addEventListener("keydown", (ev) => {
    const step = KEYS[ev.key];
    if (step === undefined || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    ev.preventDefault();
    const next = step(checked, options.length);
    pick(next);
    options[next]?.focus();
  });
  return { check };
}

/** The hair colour row (OME-1438): six swatches like the tint row's, shown with an avatar's hair ramps. */
export const buildHairRow = (): HTMLElement => buildTintRow("Hair colour", "hair-option");

/** Wires a row's swatches; `onPick` gets a tint other than the checked one. */
export function bindTintRow(group: HTMLElement, onPick: (t: Tint) => void): TintRow {
  const swatches = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  const row = bindRadioRow(group, onPick);
  return {
    show(tints, tint) {
      swatches.forEach((b, i) => {
        const ramp = tints[i];
        if (ramp === undefined) return;
        b.setAttribute("aria-label", ramp.id.charAt(0).toUpperCase() + ramp.id.slice(1));
        b.style.setProperty("--swatch", ramp.colors[1] ?? "");
      });
      row.check(tint);
    },
  };
}
