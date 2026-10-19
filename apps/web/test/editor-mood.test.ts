import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { RoomMood } from "@omega/shared";

// OME-1502: the editor's room mood picker. Four radios (none, warm, cool, night); picking one hands it to the editor,
// which puts it in the draft and saves it with the layout.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("the mood picker", () => {
  test("is a labelled radio group of the four moods, the current one checked", async () => {
    const { createMoodPicker } = await import("../src/editor/mood");
    const p = createMoodPicker(() => undefined);
    p.set("cool");
    const group = p.el.querySelector('[role="radiogroup"]');
    expect(group?.getAttribute("aria-label")).toMatch(/mood/i);
    const radios = [...p.el.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
    expect(radios.map((b) => b.dataset["mood"])).toEqual(["none", "warm", "cool", "night"]);
    expect(radios.map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "false", "true", "false"]);
    expect(radios.every((b) => b.textContent.length > 0)).toBe(true);
  });

  test("a click hands the mood over; set() moves the check", async () => {
    const { createMoodPicker } = await import("../src/editor/mood");
    const picked: RoomMood[] = [];
    const p = createMoodPicker((m) => picked.push(m));
    p.el.querySelector<HTMLButtonElement>('button[data-mood="night"]')?.click();
    expect(picked).toEqual(["night"]);
    p.set("night");
    expect(p.el.querySelector('button[data-mood="night"]')?.getAttribute("aria-checked")).toBe("true");
    expect(p.el.querySelector('button[data-mood="none"]')?.getAttribute("aria-checked")).toBe("false");
  });
});
