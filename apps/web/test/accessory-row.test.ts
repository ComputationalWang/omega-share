import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-1391: the accessory row, none plus the four head accessories (OME-1388), a radiogroup like the tint row. The landing
// has it as static markup under the tint row; the People panel builds the same markup.

async function setup(checked = 0) {
  const { bindAccessoryRow, buildAccessoryRow } = await import("../src/controls/accessory-row");
  const picked: number[] = [];
  const group = buildAccessoryRow();
  document.body.replaceChildren(group);
  bindAccessoryRow(group, (a) => picked.push(a)).check(checked);
  const radios = [...group.querySelectorAll<HTMLButtonElement>("[role=radio]")];
  return { group, picked, radios };
}

describe("accessory row", () => {
  test("nine named options in a labelled radiogroup, the current one checked and the one tab stop", async () => {
    const { group, radios } = await setup(2);
    expect(group.getAttribute("role")).toBe("radiogroup");
    expect(group.getAttribute("aria-label")).toBe("Accessory");
    expect(radios.map((r) => r.getAttribute("aria-label"))).toEqual(["None", "Party hat", "Crown", "Headphones", "Beanie", "Cap", "Flower", "Bow", "Halo"]);
    expect(radios.map((r) => r.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false", "false", "false", "false", "false", "false"]);
    expect(radios.map((r) => r.tabIndex)).toEqual([-1, -1, 0, -1, -1, -1, -1, -1, -1]);
  });

  test("a click picks that accessory; the checked one again sends nothing", async () => {
    const { radios, picked } = await setup();
    radios[8]?.click();
    radios[8]?.click();
    expect(picked).toEqual([8]);
    expect(radios[8]?.getAttribute("aria-checked")).toBe("true");
  });

  test("arrows move the choice and wrap, focus follows", async () => {
    const { group, radios, picked } = await setup();
    radios[0]?.focus();
    group.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(picked).toEqual([8]);
    expect(document.activeElement).toBe(radios[8] ?? null);
  });

  test("the landing's static row is the same markup (index.html, no layout shift)", async () => {
    const { buildAccessoryRow } = await import("../src/controls/accessory-row");
    const html = await Bun.file(new URL("../index.html", import.meta.url)).text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    const landing = doc.querySelector("[data-testid=accessory-row]");
    const built = buildAccessoryRow();
    expect(landing?.getAttribute("aria-label")).toBe(built.getAttribute("aria-label"));
    const names = (g: Element | null | undefined): (string | null)[] => [...(g?.querySelectorAll("[role=radio]") ?? [])].map((r) => r.getAttribute("aria-label"));
    expect(names(landing)).toEqual(names(built));
  });
});
