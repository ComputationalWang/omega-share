import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const LINK = "https://omega.example/r/abcdefghijklmnopqrstuvwxyz#k=kkkkkkkkkkkkkkkkkkkkk_";

describe("invite control", () => {
  test("shows the link in a read-only box and copies exactly it", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    const copied: string[] = [];
    const ctl = createInviteControl(LINK, true, (t) => {
      copied.push(t);
      return Promise.resolve();
    }).root;
    const input = ctl.querySelector("[data-testid=invite-link]");
    if (!(input instanceof HTMLInputElement)) throw new Error("no link box");
    expect(input.value).toBe(LINK);
    expect(input.readOnly).toBe(true);
    const button = ctl.querySelector("[data-testid=invite-copy]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("no copy button");
    button.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(copied).toEqual([LINK]);
    expect(button.textContent).toBe("Copied");
  });

  test("a private room warns that anyone with the link can join", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    expect(createInviteControl(LINK, true, () => Promise.resolve()).root.textContent).toContain("Anyone with this link can join");
    expect(createInviteControl(LINK, false, () => Promise.resolve()).root.textContent).not.toContain("Anyone with this link");
  });

  test("when the clipboard is refused, the link is selected for a manual copy", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    const ctl = createInviteControl(LINK, false, () => Promise.reject(new Error("denied"))).root;
    document.body.replaceChildren(ctl);
    const button = ctl.querySelector("[data-testid=invite-copy]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("no copy button");
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(button.textContent).toBe("Press Ctrl+C to copy");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("invite-link");
  });

  /** Hand-driven timers: `pending` is what is still scheduled. */
  function fakeTimers() {
    let next = 0;
    const pending = new Map<number, { fn: () => void; ms: number }>();
    return {
      pending,
      setTimer: (fn: () => void, ms: number): unknown => {
        next += 1;
        pending.set(next, { fn, ms });
        return next;
      },
      clearTimer: (h: unknown): void => {
        if (typeof h === "number") pending.delete(h);
      },
      fire: (): void => {
        const all = [...pending.entries()];
        pending.clear();
        for (const [, t] of all) t.fn();
      },
    };
  }
  const settle = (): Promise<unknown> => new Promise((r) => setTimeout(r, 0));

  test("Copied goes back to Copy after about 2s; a second click restarts the timer", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    const t = fakeTimers();
    const { root } = createInviteControl(LINK, false, () => Promise.resolve(), t);
    const button = root.querySelector("[data-testid=invite-copy]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("no copy button");
    button.click();
    await settle();
    expect(button.textContent).toBe("Copied");
    expect([...t.pending.values()].map((p) => p.ms)).toEqual([2000]);
    button.click();
    await settle();
    expect(t.pending.size).toBe(1);
    t.fire();
    expect(button.textContent).toBe("Copy");
  });

  test("success and failure are announced in a status region", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    let ok = true;
    const { root } = createInviteControl(LINK, false, () => (ok ? Promise.resolve() : Promise.reject(new Error("denied"))), fakeTimers());
    const status = root.querySelector("[role=status]");
    if (status === null) throw new Error("no status region");
    const button = root.querySelector("[data-testid=invite-copy]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("no copy button");
    button.click();
    await settle();
    expect(status.textContent).toBe("Invite link copied");
    ok = false;
    button.click();
    await settle();
    expect(status.textContent).toBe("Press Ctrl+C to copy");
  });

  test("stop clears the reset timer, so none runs after the room is left", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    const t = fakeTimers();
    const ctl = createInviteControl(LINK, false, () => Promise.resolve(), t);
    ctl.root.querySelector<HTMLButtonElement>("[data-testid=invite-copy]")?.click();
    await settle();
    expect(t.pending.size).toBe(1);
    ctl.stop();
    expect(t.pending.size).toBe(0);
  });
});
