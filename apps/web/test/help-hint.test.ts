import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// OME-768 (M9 W2): the first-visit hint. A small card that says how to use the room, once per browser, announced politely,
// gone with Esc, its close key, or the first thing it mentions. Text only.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, value: string) => {
      m.set(k, value);
    },
    map: m,
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("SecurityError");
  },
};

async function setup(opts: { touch?: boolean; store?: ReturnType<typeof memoryStore> | typeof blocked } = {}) {
  const { createFirstHint } = await import("../src/help/hint");
  const store = opts.store ?? memoryStore();
  const after = document.createElement("button");
  after.textContent = "Help";
  const hint = createFirstHint({ storage: store, touch: () => opts.touch ?? false, next: () => after });
  document.body.replaceChildren(hint.root, after);
  return { hint, store, after };
}

describe("the first-visit hint", () => {
  test("is hidden until the room shows it; then it says the four things to do, with a keyboard", async () => {
    const { hint } = await setup();
    expect(hint.root.hidden).toBe(true);
    expect(hint.isOpen()).toBe(false);
    hint.show();
    expect(hint.root.hidden).toBe(false);
    expect(hint.isOpen()).toBe(true);
    expect(hint.root.textContent).toContain("Click a seat to sit · type to chat · T for emotes · F for full screen");
  });

  test("on a touch screen it talks about tapping, not keys", async () => {
    const { hint } = await setup({ touch: true });
    hint.show();
    const text = hint.root.textContent;
    expect(text).toContain("Tap a seat to sit");
    expect(text).not.toContain("T for emotes");
    expect(text).not.toContain("F for full screen");
  });

  test("is a polite live region (announced, never interrupting)", async () => {
    const { hint } = await setup();
    const live = hint.root.querySelector("[aria-live]") ?? (hint.root.hasAttribute("aria-live") ? hint.root : null);
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(hint.root.getAttribute("role")).not.toBe("alert");
  });

  test("shows once per browser: a second room (or a reload) doesn't show it again", async () => {
    const store = memoryStore();
    const first = await setup({ store });
    first.hint.show();
    expect(first.hint.isOpen()).toBe(true);
    const second = await setup({ store });
    second.hint.show();
    expect(second.hint.isOpen()).toBe(false);
    expect(second.hint.root.hidden).toBe(true);
  });

  test("blocked storage: it still shows on this page, and nothing throws", async () => {
    const { hint } = await setup({ store: blocked });
    expect(() => {
      hint.show();
    }).not.toThrow();
    expect(hint.isOpen()).toBe(true);
    expect(() => {
      hint.dismiss();
    }).not.toThrow();
    expect(hint.isOpen()).toBe(false);
  });

  test("its close key (labelled, a real button) dismisses it", async () => {
    const { hint } = await setup();
    hint.show();
    const close = hint.root.querySelector<HTMLButtonElement>("button[data-testid=first-hint-close]");
    expect(close).not.toBeNull();
    expect(close?.getAttribute("aria-label") ?? close?.textContent ?? "").toMatch(/dismiss|close|got it/i);
    close?.click();
    expect(hint.isOpen()).toBe(false);
    expect(hint.root.hidden).toBe(true);
  });

  test("dismiss() (Esc, sitting, chatting, emotes, full screen) hides it for good; a later show() does nothing", async () => {
    const { hint } = await setup();
    hint.show();
    hint.dismiss();
    expect(hint.isOpen()).toBe(false);
    hint.show();
    expect(hint.isOpen()).toBe(false);
  });

  test("closing it with its own key hands focus to the next key, never to <body> or the hidden card", async () => {
    const { hint, after } = await setup();
    hint.show();
    const close = hint.root.querySelector<HTMLButtonElement>("[data-testid=first-hint-close]");
    close?.focus();
    close?.click();
    expect(document.activeElement).toBe(after);
  });

  test("dismissed some other way while you weren't on it: focus stays where it was", async () => {
    const { hint } = await setup();
    const field = document.createElement("input");
    document.body.append(field);
    hint.show();
    field.focus();
    hint.dismiss();
    expect(document.activeElement).toBe(field);
  });
});
