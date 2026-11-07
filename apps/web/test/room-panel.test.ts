import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => { GlobalRegistrator.register(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

async function panel() {
  const { createRoomPanel } = await import("../src/room-panel");
  const p = createRoomPanel();
  document.body.replaceChildren(p.root);
  const tabs = [...p.root.querySelectorAll<HTMLButtonElement>("[role=tab]")];
  const panels = [...p.root.querySelectorAll<HTMLElement>("[role=tabpanel]")];
  return { p, tabs, panels };
}

const key = (target: HTMLElement, k: string): KeyboardEvent => {
  const ev = new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(ev);
  return ev;
};

test("Chat, Up next and Room are a tablist whose tabs control their own panels; Chat starts selected", async () => {
  const { p, tabs, panels } = await panel();
  expect(p.root.querySelector("[role=tablist]")).not.toBeNull();
  expect(tabs.map((t) => t.textContent)).toEqual(["Chat", "Up next", "Room"]);
  expect(panels).toHaveLength(3);
  tabs.forEach((t, i) => {
    const panelEl = panels[i];
    expect(t.getAttribute("aria-controls")).toBe(panelEl?.id ?? "missing");
    expect(panelEl?.getAttribute("aria-labelledby")).toBe(t.id);
  });
  expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false", "false"]);
  expect(tabs.map((t) => t.tabIndex)).toEqual([0, -1, -1]);
  expect(panels.map((e) => e.hidden)).toEqual([false, true, true]);
  expect(p.selected()).toBe("chat");
});

test("a click selects its tab and shows only its panel", async () => {
  const { p, tabs, panels } = await panel();
  tabs[1]?.click();
  expect(p.selected()).toBe("queue");
  expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
  expect(tabs.map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
  expect(panels.map((e) => e.hidden)).toEqual([true, false, true]);
});

test("Left and Right wrap, Home and End jump, and focus follows the selection; the room never sees the arrow", async () => {
  const { p, tabs } = await panel();
  let walked = 0;
  document.body.addEventListener("keydown", () => { walked++; });
  const [chat, queue, room] = tabs;
  if (chat === undefined || queue === undefined || room === undefined) throw new Error("tabs");
  chat.focus();
  expect(key(chat, "ArrowLeft").defaultPrevented).toBe(true);
  expect(p.selected()).toBe("room");
  expect(document.activeElement).toBe(room);
  key(room, "ArrowRight");
  expect(p.selected()).toBe("chat");
  expect(document.activeElement).toBe(chat);
  key(chat, "End");
  expect(document.activeElement).toBe(room);
  key(room, "Home");
  expect(document.activeElement).toBe(chat);
  key(chat, "ArrowRight");
  expect(p.selected()).toBe("queue");
  expect(walked).toBe(0);
});

test("select() from code (People, a shared link) changes the tab and tells the listener once", async () => {
  const { createRoomPanel } = await import("../src/room-panel");
  const seen: string[] = [];
  const p = createRoomPanel({ onSelect: (k) => { seen.push(k); } });
  p.select("room");
  p.select("room");
  expect(p.selected()).toBe("room");
  expect(p.panels.room.hidden).toBe(false);
  expect(seen).toEqual(["room"]);
});
