import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { COMMANDS, type SlashEntry } from "../src/chat/commands";
import { HELP_LINE, slashCommand } from "../src/chat/effects";

// OME-1586: the command palette ("✦" next to the emote key). One table feeds the palette, the slash parser and /help,
// so a command added anywhere shows everywhere.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const slashes = COMMANDS.filter((c): c is SlashEntry => c.section !== "moves");
const named = (name: string): SlashEntry | undefined => slashes.find((c) => c.name === name);

describe("one command table", () => {
  test("the emotes are the picker's (dance is fun), the fun list is the issue's, the moves each have a hint", () => {
    expect(slashes.filter((c) => c.section === "emotes").map((c) => c.name)).toEqual(["heart", "laugh", "question", "exclaim", "clap", "wave", "cheer", "yawn"]);
    expect(slashes.filter((c) => c.section === "fun").map((c) => c.name)).toEqual(expect.arrayContaining(["dance", "roll", "poll", "conga", "snap", "think", "me", "hug", "highfive", "sit"]));
    const moves = COMMANDS.filter((c) => c.section === "moves");
    expect(moves.map((c) => c.label)).toEqual(["Walk", "Jog", "Follow", "Walk over", "Teleport pads", "Doors"]);
    for (const m of moves) expect(m.hint.length).toBeGreaterThan(10);
  });

  test("the palette runs emotes, /dance, /snap, /sit and /roll; it fills /poll and /hug with a placeholder", () => {
    for (const name of ["heart", "wave", "dance", "snap", "sit", "roll"]) expect(named(name)?.does).toBe("run");
    expect(named("dance")?.text).toBe("/dance");
    expect(named("poll")).toMatchObject({ does: "fill", text: "/poll Question? A | B" });
    expect(named("hug")).toMatchObject({ does: "fill", text: "/hug @" });
  });

  test("the parser knows every word in the table, aliases too; a word that isn't there is chat", () => {
    for (const c of slashes) for (const w of [c.name, ...c.aliases]) expect(slashCommand(`/${w}`)).not.toBeNull();
    for (const w of ["x", "dancing", "helpme", "stopp", "meow", "highfives", "lolz"]) expect(slashCommand(`/${w}`)).toBeNull();
  });

  test("/me, /think, /conga and /stop travel as chat lines: the parser says so instead of running them", () => {
    for (const text of ["/me waves", "/think hm", "/conga", "/stop"]) expect(slashCommand(text)).toEqual({ type: "line" });
  });

  test("/help names every command and alias in the table", () => {
    for (const c of slashes) {
      expect(HELP_LINE.verb).toContain(c.help);
      for (const a of c.aliases) expect(HELP_LINE.verb).toContain(`/${a}`);
    }
  });
});

async function setup() {
  const { createCommandPalette } = await import("../src/chat/palette");
  const form = document.createElement("form");
  const input = document.createElement("input");
  const submitted: string[] = [];
  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    submitted.push(input.value);
    input.value = "";
  });
  const palette = createCommandPalette({ input, form });
  form.append(palette.root, input);
  document.body.replaceChildren(form);
  const items = (): HTMLButtonElement[] => [...palette.dialog.querySelectorAll<HTMLButtonElement>("[data-testid=palette-item]")];
  const item = (text: string): HTMLButtonElement => {
    const b = items().find((e) => e.dataset["command"] === text);
    if (b === undefined) throw new Error(`no item ${text}`);
    return b;
  };
  return { palette, input, submitted, items, item };
}

describe("the palette", () => {
  test("its key opens a labelled modal dialog listing every entry of the table, in its section", async () => {
    const { palette, items } = await setup();
    expect(palette.key.getAttribute("aria-haspopup")).toBe("dialog");
    expect(palette.key.getAttribute("aria-label")).toBe("More commands");
    palette.key.click();
    expect(palette.dialog.open).toBe(true);
    const title = palette.dialog.querySelector(`#${palette.dialog.getAttribute("aria-labelledby") ?? "none"}`);
    expect(title?.textContent).toBe("Commands");
    expect(items().map((b) => b.dataset["command"])).toEqual(slashes.map((c) => c.text));
    expect([...palette.dialog.querySelectorAll("h3")].map((h) => h.textContent)).toEqual(["Emotes", "Fun", "Moves"]);
    for (const m of COMMANDS.filter((c) => c.section === "moves")) expect(palette.dialog.textContent).toContain(m.hint);
    expect(document.activeElement).toBe(items()[0] ?? null);
  });

  test("a run entry goes out through the composer form, the draft stays in the field, the dialog closes", async () => {
    const { palette, input, submitted, item } = await setup();
    input.value = "half a sentence";
    palette.key.click();
    item("/dance").click();
    expect(submitted).toEqual(["/dance"]);
    expect(input.value).toBe("half a sentence");
    expect(palette.dialog.open).toBe(false);
    expect(document.activeElement).toBe(palette.key);
  });

  test("a fill entry puts the command in the field with its placeholder selected, sends nothing, focuses the field", async () => {
    const { palette, input, submitted, item } = await setup();
    palette.key.click();
    item("/poll Question? A | B").click();
    expect(submitted).toEqual([]);
    expect(input.value).toBe("/poll Question? A | B");
    expect(input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0)).toBe("Question? A | B");
    expect(palette.dialog.open).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  test("arrows, Home and End move between entries; Esc closes and focus goes back to the key; no key leaks to the page", async () => {
    const { palette, items } = await setup();
    let leaked = 0;
    const onWindow = (): void => {
      leaked++;
    };
    window.addEventListener("keydown", onWindow);
    palette.key.click();
    const press = (key: string): void => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    };
    press("ArrowDown");
    expect(document.activeElement).toBe(items()[1] ?? null);
    press("ArrowUp");
    press("ArrowUp");
    expect(document.activeElement).toBe(items().at(-1) ?? null);
    press("Home");
    expect(document.activeElement).toBe(items()[0] ?? null);
    press("End");
    expect(document.activeElement).toBe(items().at(-1) ?? null);
    press("1");
    expect(leaked).toBe(0);
    palette.dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(palette.dialog.open).toBe(false);
    expect(document.activeElement).toBe(palette.key);
    window.removeEventListener("keydown", onWindow);
  });
});
