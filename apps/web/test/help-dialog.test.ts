import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// OME-768 (M9 W2): the "?" help dialog. A key in the room bar and the `?` key (the same rules as T: never in a text field,
// never with Ctrl/Alt/Meta, never over another dialog) open a modal <dialog> that lists the keyboard and touch controls,
// the owner's tools (owners only), how to report a room, and the footer pages. Static DOM, built on the first open; focus
// is trapped inside and goes back where it was. Text only.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function setup(o: { owner?: boolean } = {}) {
  const { createHelp } = await import("../src/help/dialog");
  let owner = o.owner ?? false;
  const help = createHelp({ owner: () => owner });
  const field = document.createElement("input");
  const other = document.createElement("button");
  other.textContent = "Elsewhere";
  document.body.replaceChildren(help.key, other, field, help.dialog);
  const press = (key: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent => {
    const ev = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    Object.defineProperty(ev, "target", { value: target });
    return ev;
  };
  return {
    help,
    field,
    other,
    press,
    setOwner: (on: boolean) => {
      owner = on;
    },
  };
}

const text = (e: Element): string => e.textContent;
const shown = (root: Element, sel: string): Element[] =>
  [...root.querySelectorAll(sel)].filter((e) => {
    for (let n: Element | null = e; n !== null; n = n.parentElement) if (n instanceof HTMLElement && n.hidden) return false;
    return true;
  });

describe("the help key", () => {
  test("is a labelled button in the room bar that says it opens a dialog and answers to ?", async () => {
    const { help } = await setup();
    expect(help.key.tagName).toBe("BUTTON");
    expect(help.key.getAttribute("aria-label") ?? help.key.textContent).toMatch(/help/i);
    expect(help.key.getAttribute("aria-haspopup")).toBe("dialog");
    expect(help.key.getAttribute("aria-keyshortcuts")).toBe("?");
    expect(help.key.dataset["testid"]).toBe("help-key");
  });

  test("the dialog is empty until the first open (static DOM, built once), then the same nodes every time", async () => {
    const { help } = await setup();
    expect(help.dialog.childElementCount).toBe(0);
    help.key.click();
    expect(help.isOpen()).toBe(true);
    expect(help.dialog.open).toBe(true);
    const first = help.dialog.firstElementChild;
    expect(first).not.toBeNull();
    help.close();
    help.key.click();
    expect(help.dialog.firstElementChild).toBe(first);
  });
});

describe("what it says", () => {
  test("a labelled modal: keyboard controls (sit, chat, T, 1–8, F, Enter, Esc, ?) and touch controls", async () => {
    const { help } = await setup();
    help.key.click();
    expect(help.dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = help.dialog.getAttribute("aria-labelledby") ?? "";
    expect(document.getElementById(labelledBy)?.textContent).toMatch(/help|how/i);
    const all = text(help.dialog);
    for (const k of ["S", "T", "1–8", "F", "Enter", "Esc", "?"]) expect(shown(help.dialog, "kbd").map(text)).toContain(k);
    expect(all).toMatch(/click a seat/i);
    expect(all).toMatch(/sit on the floor/i);
    expect(all).toMatch(/touch/i);
    expect(all).toMatch(/tap a seat/i);
  });

  test("how to report a room, for a guest", async () => {
    const { help } = await setup();
    help.key.click();
    expect(shown(help.dialog, "[data-testid=help-report]").length).toBe(1);
    expect(text(help.dialog)).toMatch(/Report room/);
    // On a phone the Report key sits in the Room panel, not at the bottom (OME-1597).
    expect(shown(help.dialog, "[data-testid=help-report]").map(text).join("")).toMatch(/[Oo]n a phone[^.]*\bRoom\b/);
  });

  test("keyboard first with a mouse, touch first on a touch screen (OME-1597)", async () => {
    const headings = (d: HTMLDialogElement): string[] => [...d.querySelectorAll("h3")].map(text);
    const { help } = await setup();
    help.key.click();
    expect(headings(help.dialog).slice(0, 2)).toEqual(["With a keyboard", "On a touch screen"]);
    const real = window.matchMedia.bind(window);
    window.matchMedia = (q: string) => (q === "(pointer: coarse)" ? Object.defineProperty(real(q), "matches", { value: true }) : real(q));
    try {
      const touch = await setup();
      touch.help.key.click();
      expect(headings(touch.help.dialog).slice(0, 2)).toEqual(["On a touch screen", "With a keyboard"]);
    } finally {
      window.matchMedia = real;
    }
  });

  test("owner tools only when you own the room, checked on every open", async () => {
    const { help, setOwner } = await setup();
    help.key.click();
    expect(shown(help.dialog, "[data-testid=help-owner]")).toEqual([]);
    help.close();
    setOwner(true);
    help.key.click();
    const owner = shown(help.dialog, "[data-testid=help-owner]");
    expect(owner.length).toBe(1);
    expect(text(owner[0] ?? help.dialog)).toMatch(/Edit room/);
    expect(text(owner[0] ?? help.dialog)).toMatch(/mute|remove/i);
    expect(text(owner[0] ?? help.dialog)).toMatch(/playback/i);
  });

  test("links to the footer pages: privacy, terms, contact, licences (same site, plain hrefs)", async () => {
    const { help } = await setup();
    help.key.click();
    const hrefs = [...help.dialog.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    for (const page of ["/privacy.html", "/terms.html", "/contact.html", "/licenses.html"]) expect(hrefs).toContain(page);
  });
});

describe("the ? key", () => {
  test("opens the dialog from the page", async () => {
    const { help, press } = await setup();
    expect(help.shortcut(press("?", { shiftKey: true }))).toBe(true);
    expect(help.isOpen()).toBe(true);
  });

  test("never while typing in a field, never with Ctrl/Alt/Meta, never over another open dialog", async () => {
    const { help, press, field } = await setup();
    expect(help.shortcut(press("?", { shiftKey: true }, field))).toBe(false);
    expect(help.shortcut(press("?", { ctrlKey: true }))).toBe(false);
    expect(help.shortcut(press("?", { altKey: true }))).toBe(false);
    expect(help.shortcut(press("?", { metaKey: true }))).toBe(false);
    const other = document.createElement("dialog");
    document.body.append(other);
    other.showModal();
    expect(help.shortcut(press("?", { shiftKey: true }))).toBe(false);
    other.close();
    expect(help.isOpen()).toBe(false);
  });

  test("other keys are not its business", async () => {
    const { help, press } = await setup();
    expect(help.shortcut(press("/"))).toBe(false);
    expect(help.shortcut(press("t"))).toBe(false);
    expect(help.isOpen()).toBe(false);
  });
});

describe("focus", () => {
  test("goes into the dialog on open, and back to the key on close", async () => {
    const { help } = await setup();
    help.key.focus();
    help.key.click();
    expect(help.dialog.contains(document.activeElement)).toBe(true);
    help.close();
    expect(help.isOpen()).toBe(false);
    expect(document.activeElement).toBe(help.key);
  });

  test("opened with ? from elsewhere: focus goes back to where it was", async () => {
    const { help, press, other } = await setup();
    other.focus();
    help.shortcut(press("?", { shiftKey: true }, other));
    expect(help.dialog.contains(document.activeElement)).toBe(true);
    help.close();
    expect(document.activeElement).toBe(other);
  });

  test("Esc closes it and focus goes back", async () => {
    const { help } = await setup();
    help.key.focus();
    help.key.click();
    const cancel = new Event("cancel", { cancelable: true });
    help.dialog.dispatchEvent(cancel);
    expect(help.isOpen()).toBe(false);
    expect(document.activeElement).toBe(help.key);
  });

  test("is trapped: Tab past the last stop wraps to the first, Shift+Tab before the first wraps to the last", async () => {
    const { help } = await setup();
    help.key.click();
    const stops = [...help.dialog.querySelectorAll<HTMLElement>("a[href], button")];
    const first = stops[0];
    const last = stops.at(-1);
    if (first === undefined || last === undefined) throw new Error("no stops");
    last.focus();
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    last.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);
    const back = new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true });
    first.dispatchEvent(back);
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  test("has a Close key", async () => {
    const { help } = await setup();
    help.key.click();
    const close = help.dialog.querySelector<HTMLButtonElement>("[data-testid=help-close]");
    expect(close).not.toBeNull();
    close?.click();
    expect(help.isOpen()).toBe(false);
  });
});

describe("the cinema dim toggle (OME-1406)", () => {
  test("a Cinema dim checkbox shows the setting and switches it", async () => {
    const { createHelp } = await import("../src/help/dialog");
    let on = true;
    const seen: boolean[] = [];
    const help = createHelp({
      owner: () => false,
      cinema: {
        on: () => on,
        set: (v) => {
          on = v;
          seen.push(v);
        },
      },
    });
    document.body.replaceChildren(help.key, help.dialog);
    help.key.click();
    const box = help.dialog.querySelector<HTMLInputElement>('input[type="checkbox"][data-testid="cinema-toggle"]');
    expect(box).not.toBeNull();
    if (box === null) return;
    expect(box.labels?.[0]?.textContent).toMatch(/cinema dim/i);
    expect(box.checked).toBe(true);
    box.click();
    expect(seen).toEqual([false]);
    help.close();
    on = true;
    help.key.click();
    expect(box.checked).toBe(true);
  });
});

describe("Show tips again (OME-1587)", () => {
  test("a Show tips again key closes the dialog and starts the first-visit tour", async () => {
    const { createHelp } = await import("../src/help/dialog");
    let tips = 0;
    const help = createHelp({
      owner: () => false,
      tips: () => {
        tips += 1;
      },
    });
    document.body.replaceChildren(help.key, help.dialog);
    help.key.click();
    const again = help.dialog.querySelector<HTMLButtonElement>('button[data-testid="help-tips"]');
    expect(again?.textContent).toBe("Show tips again");
    again?.click();
    expect(tips).toBe(1);
    expect(help.isOpen()).toBe(false);
    expect(document.activeElement).toBe(help.key);
  });
});
