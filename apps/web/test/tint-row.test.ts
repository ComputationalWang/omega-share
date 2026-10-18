import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-1352: the shirt tint row (ADR 0053), a 6-swatch radiogroup. The landing has it as static markup under the avatar
// picker (no layout shift); the room builds the same markup. Swatches are named for screen readers.

const JUNO = ["mustard", "teal", "rust", "lilac", "pink", "olive"].map((id, i) => ({ id, colors: ["#000000", `#00000${String(i)}`, "#000000"] as const }));
const PIP = ["teal", "mustard", "lilac", "pink", "olive", "velvet"].map((id) => ({ id, colors: ["#000000", "#111111", "#000000"] as const }));

async function setup() {
  const { bindTintRow, buildTintRow } = await import("../src/controls/tint-row");
  const picked: number[] = [];
  const group = buildTintRow();
  document.body.replaceChildren(group);
  const row = bindTintRow(group, (t) => picked.push(t));
  row.show(JUNO, 0);
  const radios = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  return { group, row, picked, radios };
}

const key = (target: HTMLElement, k: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
};

describe("tint row", () => {
  test("six named swatches in a labelled radiogroup, the current one checked and the one tab stop", async () => {
    const { group, radios } = await setup();
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Shirt colour");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Mustard", "Teal", "Rust", "Lilac", "Pink", "Olive"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["true", "false", "false", "false", "false", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([0, -1, -1, -1, -1, -1]);
    expect(radios[2]?.style.getPropertyValue("--swatch")).toBe("#000002");
  });

  test("a click picks that tint and checks it", async () => {
    const { radios, picked } = await setup();
    radios[2]?.click();
    expect(picked).toEqual([2]);
    expect(radios[2]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[0]?.getAttribute("aria-checked")).toBe("false");
    // Clicking the checked one again sends nothing (the server would no-op it, and it costs a token).
    radios[2]?.click();
    expect(picked).toEqual([2]);
  });

  test("arrows move the choice and wrap, Home and End go to the ends, focus follows", async () => {
    const { group, radios, picked } = await setup();
    radios[0]?.focus();
    key(group, "ArrowLeft");
    expect(picked).toEqual([5]);
    expect(document.activeElement).toBe(radios[5] ?? null);
    key(group, "ArrowRight");
    key(group, "Home");
    key(group, "End");
    expect(picked).toEqual([5, 0, 5]);
  });

  test("showing another avatar's ramps relabels and recolours, without picking", async () => {
    const { row, radios, picked } = await setup();
    row.show(PIP, 3);
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["Teal", "Mustard", "Lilac", "Pink", "Olive", "Velvet"]);
    expect(radios[3]?.getAttribute("aria-checked")).toBe("true");
    expect(radios[3]?.style.getPropertyValue("--swatch")).toBe("#111111");
    expect(picked).toEqual([]);
  });
});
