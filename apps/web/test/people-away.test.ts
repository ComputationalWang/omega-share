import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Member } from "@omega/shared";

// OME-911: an away member keeps their row and button, with an accessible "Away" label.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ada: Member = { id: "a", nickname: "Ada", avatar: 0 };
const bo: Member = { id: "b", nickname: "Bo", avatar: 1 };

describe("people list away label", () => {
  test("shows Away while away, drops it on return, and keeps the toggle button", async () => {
    const { createPeople } = await import("../src/hide/people");
    const { createHiddenMembers } = await import("../src/hide/hidden");
    const data = new Map<string, string>();
    const hidden = createHiddenMembers({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) }, "lobby");
    const people = createPeople({ hidden, onChange: () => undefined, walkOver: () => null, follow: () => undefined, sit: () => undefined });
    document.body.replaceChildren(people.key, people.panel, people.status);
    const row = (id: string): HTMLElement | null => people.panel.querySelector<HTMLElement>(`[data-member="${id}"]`);

    people.update([ada, bo], "a");
    expect(row("b")?.textContent).not.toContain("Away");
    people.update([ada, { ...bo, away: true }], "a");
    expect(row("b")?.textContent).toContain("Away");
    expect(row("b")?.classList.contains("is-away")).toBe(true);
    expect(row("b")?.querySelector("button")).not.toBeNull();
    expect(row("a")?.textContent).not.toContain("Away");
    people.update([ada, { ...bo, away: false }], "a");
    expect(row("b")?.textContent).not.toContain("Away");
    expect(row("b")?.classList.contains("is-away")).toBe(false);
  });
});
