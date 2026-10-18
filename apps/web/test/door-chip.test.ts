import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// OME-1425: arriving in front of a door offers "Go to <room> · Stay"; nothing happens by itself.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function setup() {
  const { createDoorChip } = await import("../src/door-chip");
  const went: string[] = [];
  const chip = createDoorChip({ titleOf: (id) => (id === "film-club" ? "Film <b>club</b>" : null), go: (p) => went.push(p) });
  document.body.replaceChildren(chip.root);
  const button = (name: string): HTMLButtonElement | undefined => [...chip.root.querySelectorAll("button")].find((b) => b.textContent === name);
  return { chip, went, button };
}

describe("door chip", () => {
  test("hidden until I stand in front of a door; then 'Go to <title> · Stay', the title as text", async () => {
    const { chip, button } = await setup();
    expect(chip.root.hidden).toBe(true);
    chip.at("film-club");
    expect(chip.root.hidden).toBe(false);
    expect(chip.root.textContent).toBe("Go to Film <b>club</b> · Stay");
    expect(chip.root.querySelector("b")).toBeNull();
    expect(button("Go to Film <b>club</b>")).toBeDefined();
    expect(button("Stay")).toBeDefined();
  });

  test("a room I have no title for is 'another room'", async () => {
    const { chip } = await setup();
    chip.at("unknown-room");
    expect(chip.root.textContent).toBe("Go to another room · Stay");
  });

  test("Go goes to /r/<room>; nothing goes by itself", async () => {
    const { chip, went, button } = await setup();
    chip.at("film-club");
    expect(went).toEqual([]);
    button("Go to Film <b>club</b>")?.click();
    expect(went).toEqual(["/r/film-club"]);
  });

  test("Stay hides it, and it stays hidden while I stand there; leaving and arriving again shows it", async () => {
    const { chip, button } = await setup();
    chip.at("film-club");
    button("Stay")?.click();
    expect(chip.root.hidden).toBe(true);
    chip.at("film-club");
    expect(chip.root.hidden).toBe(true);
    chip.at(null);
    expect(chip.root.hidden).toBe(true);
    chip.at("film-club");
    expect(chip.root.hidden).toBe(false);
  });

  test("walking away hides it; stepping to a different door shows that door's room", async () => {
    const { chip } = await setup();
    chip.at("film-club");
    chip.at(null);
    expect(chip.root.hidden).toBe(true);
    chip.at("film-club");
    chip.at("unknown-room");
    expect(chip.root.textContent).toBe("Go to another room · Stay");
  });
});
