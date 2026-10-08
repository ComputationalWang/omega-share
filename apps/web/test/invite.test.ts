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
    });
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
    expect(createInviteControl(LINK, true, () => Promise.resolve()).textContent).toContain("Anyone with this link can join");
    expect(createInviteControl(LINK, false, () => Promise.resolve()).textContent).not.toContain("Anyone with this link");
  });

  test("when the clipboard is refused, the link is selected for a manual copy", async () => {
    const { createInviteControl } = await import("../src/controls/invite");
    const ctl = createInviteControl(LINK, false, () => Promise.reject(new Error("denied")));
    document.body.replaceChildren(ctl);
    const button = ctl.querySelector("[data-testid=invite-copy]");
    if (!(button instanceof HTMLButtonElement)) throw new Error("no copy button");
    button.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(button.textContent).toBe("Press Ctrl+C to copy");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("invite-link");
  });
});
