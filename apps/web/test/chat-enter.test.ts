import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-642: Enter to chat. With nothing that takes Enter itself focused, Enter jumps to the chat field; Esc in the field
// hands the keys back to the room. A focused key, link, field or anything in a dialog keeps Enter's own meaning.

interface Key {
  key: string;
  target: EventTarget | null;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
  repeat?: boolean;
  defaultPrevented?: boolean;
}

async function setup() {
  const { chatKey } = await import("../src/chat/enter");
  const input = document.createElement("input");
  document.body.append(input);
  const ev = (k: Key) => ({ ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, isComposing: false, repeat: false, defaultPrevented: false, ...k });
  return { chatKey: (k: Key) => chatKey(ev(k), input), input };
}

describe("chatKey: Enter", () => {
  test("on the page itself (nothing focused) it focuses the chat", async () => {
    const { chatKey } = await setup();
    expect(chatKey({ key: "Enter", target: document.body })).toBe("focus");
  });

  test("on a focusable box that isn't a control (the chat log, the room's window) it focuses the chat", async () => {
    const { chatKey } = await setup();
    const log = document.createElement("div");
    log.tabIndex = 0;
    document.body.append(log);
    expect(chatKey({ key: "Enter", target: log })).toBe("focus");
  });

  test.each(["button", "a", "input", "textarea", "select", "summary"])("on a focused <%s> it keeps its own meaning", async (tag) => {
    const { chatKey } = await setup();
    const e = document.createElement(tag);
    if (e instanceof HTMLAnchorElement) e.href = "/";
    document.body.append(e);
    expect(chatKey({ key: "Enter", target: e })).toBe(null);
  });

  test("on a role=button / role=link / role=radio element, or a contenteditable, it keeps its own meaning", async () => {
    const { chatKey } = await setup();
    for (const role of ["button", "link", "radio", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "checkbox", "switch", "textbox", "searchbox", "combobox", "treeitem", "gridcell"]) {
      const e = document.createElement("div");
      e.setAttribute("role", role);
      document.body.append(e);
      expect(chatKey({ key: "Enter", target: e })).toBe(null);
    }
    const ed = document.createElement("div");
    ed.contentEditable = "true";
    document.body.append(ed);
    expect(chatKey({ key: "Enter", target: ed })).toBe(null);
  });

  test("inside an open dialog it does nothing", async () => {
    const { chatKey } = await setup();
    const d = document.createElement("dialog");
    const p = document.createElement("p");
    p.tabIndex = 0;
    d.append(p);
    document.body.append(d);
    expect(chatKey({ key: "Enter", target: p })).toBe(null);
  });

  test("with a modifier, or while an IME is composing, it does nothing", async () => {
    const { chatKey } = await setup();
    for (const m of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }]) {
      expect(chatKey({ key: "Enter", target: document.body, ...m })).toBe(null);
    }
  });

  test("held down (auto-repeat) it does nothing: a held Enter never reaches the field to send a draft", async () => {
    const { chatKey } = await setup();
    expect(chatKey({ key: "Enter", target: document.body, repeat: true })).toBe(null);
  });

  test("already handled by someone else (defaultPrevented) it does nothing", async () => {
    const { chatKey } = await setup();
    expect(chatKey({ key: "Enter", target: document.body, defaultPrevented: true })).toBe(null);
  });

  test("in the chat field itself it is the form's (send), not ours", async () => {
    const { chatKey, input } = await setup();
    expect(chatKey({ key: "Enter", target: input })).toBe(null);
  });

  test("other keys do nothing", async () => {
    const { chatKey } = await setup();
    expect(chatKey({ key: "a", target: document.body })).toBe(null);
    expect(chatKey({ key: " ", target: document.body })).toBe(null);
  });
});

describe("chatKey: Escape", () => {
  test("in the chat field it blurs back to the room", async () => {
    const { chatKey, input } = await setup();
    expect(chatKey({ key: "Escape", target: input })).toBe("blur");
  });

  test("anywhere else it is not ours", async () => {
    const { chatKey } = await setup();
    expect(chatKey({ key: "Escape", target: document.body })).toBe(null);
    const other = document.createElement("input");
    document.body.append(other);
    expect(chatKey({ key: "Escape", target: other })).toBe(null);
  });
});
