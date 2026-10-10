import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Member, MemberId } from "@omega/shared";

// OME-769 (M9 W3): the people list and "Hide for me". A "People" key in the room bar opens a list of who's in the room;
// on anyone but me there is a real button, "Hide for me" / "Show", whose name says who. A hidden person keeps their
// place in the list with a "hidden" badge. Each change is said once in a status region. Client-only: the list has no way
// to send anything, it only tells the room (onChange) so the stage and the logs follow.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ada: Member = { id: "a", nickname: "Ada", avatar: 0 };
const bo: Member = { id: "b", nickname: "Bo", avatar: 1 };
const kit: Member = { id: "k", nickname: "<b>Kit</b>", avatar: 2 };

async function setup(members: readonly Member[] = [ada, bo, kit], self: MemberId | null = "a") {
  const { createPeople } = await import("../src/hide/people");
  const { createHiddenMembers } = await import("../src/hide/hidden");
  const data = new Map<string, string>();
  const hidden = createHiddenMembers({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }, "lobby");
  const changes: [MemberId, boolean][] = [];
  const people = createPeople({ hidden, onChange: (id, on) => changes.push([id, on]) });
  document.body.replaceChildren(people.key, people.panel, people.status);
  people.update(members, self);
  const row = (id: string): HTMLElement | null => people.panel.querySelector<HTMLElement>(`[data-member="${id}"]`);
  const button = (id: string): HTMLButtonElement | null => row(id)?.querySelector("button") ?? null;
  return { people, hidden, changes, row, button };
}

describe("people list", () => {
  test("the key is a real button that opens and closes the list, and says so", async () => {
    const { people } = await setup();
    expect(people.key.tagName).toBe("BUTTON");
    expect(people.key.getAttribute("aria-label")).toBe("People");
    expect(people.key.getAttribute("aria-expanded")).toBe("false");
    expect(people.panel.hidden).toBe(true);
    people.key.click();
    expect(people.isOpen()).toBe(true);
    expect(people.panel.hidden).toBe(false);
    expect(people.key.getAttribute("aria-expanded")).toBe("true");
    expect(people.key.getAttribute("aria-controls")).toBe(people.panel.id);
    people.key.click();
    expect(people.panel.hidden).toBe(true);
  });

  test("one row per member, names as text; only others have a Hide for me button naming them", async () => {
    const { people, row, button } = await setup();
    expect([...people.panel.querySelectorAll("[data-member]")].map((r) => r.getAttribute("data-member"))).toEqual(["a", "b", "k"]);
    expect(row("k")?.querySelector("b")).toBeNull();
    expect(row("k")?.textContent).toContain("<b>Kit</b>");
    expect(button("a")).toBeNull();
    expect(row("a")?.textContent).toContain("(you)");
    expect(button("b")?.textContent).toBe("Hide for me");
    expect(button("b")?.getAttribute("aria-label")).toBe("Hide Bo for me");
    expect(button("b")?.type).toBe("button");
  });

  test("Hide for me: the row gets a hidden badge, the button becomes Show, the change is announced and reported", async () => {
    const { people, hidden, changes, row, button } = await setup();
    button("b")?.click();
    expect(hidden.has("b")).toBe(true);
    expect(changes).toEqual([["b", true]]);
    expect(row("b")?.querySelector(".people-hidden")?.textContent).toBe("hidden");
    expect(button("b")?.textContent).toBe("Show");
    expect(button("b")?.getAttribute("aria-label")).toBe("Show Bo");
    expect(people.status.getAttribute("role")).toBe("status");
    expect(people.status.textContent).toBe("Bo is hidden for you. Only you see this.");
    button("b")?.click();
    expect(hidden.has("b")).toBe(false);
    expect(changes).toEqual([["b", true], ["b", false]]);
    expect(row("b")?.querySelector(".people-hidden")).toBeNull();
    expect(button("b")?.textContent).toBe("Hide for me");
    expect(people.status.textContent).toBe("Bo is shown again.");
  });

  test("the toggled button keeps focus (the row isn't rebuilt)", async () => {
    const { people, button } = await setup();
    people.open();
    const b = button("b");
    b?.focus();
    b?.click();
    expect(button("b")).toBe(b ?? null);
    expect(document.activeElement).toBe(b ?? null);
  });

  test("someone hidden before (a reconnect) shows as hidden; a leaver's row goes; the same members change nothing", async () => {
    const { people, hidden, row, button } = await setup();
    hidden.set("k", true);
    people.update([ada, bo, kit], "a");
    expect(row("k")?.querySelector(".people-hidden")).not.toBeNull();
    expect(button("k")?.textContent).toBe("Show");
    const before = row("b");
    const members = [ada, bo];
    people.update(members, "a");
    expect(row("k")).toBeNull();
    expect(row("b")).toBe(before);
  });

  test("open(id) (a long-press or right-click on their name tag) opens the list on their button", async () => {
    const { people, button } = await setup();
    people.open("k");
    expect(people.isOpen()).toBe(true);
    expect(document.activeElement).toBe(button("k"));
  });

  test("Escape closes the list and gives focus back to the key", async () => {
    const { people } = await setup();
    people.key.click();
    people.panel.querySelector("button")?.focus();
    people.panel.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(people.isOpen()).toBe(false);
    expect(document.activeElement).toBe(people.key);
  });
});
