// @mentions (OME-1531), client-only: a line naming me is highlighted in my log, its speaker's bubble gets a ring for me,
// a hidden tab's title shows (@), and typing @ in the composer offers the present members (an ARIA combobox). The
// matching itself (case, accents, confusables, whole words) is a unit test (apps/web/test/chat-mention.test.ts).
import type { Page } from "@playwright/test";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Playwright's page never hides on its own: stand in for a tab switch, the way the browser reports one. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (h ? "hidden" : "visible") });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => h });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("@ completes a present member; the named one sees the line highlighted, a ring on the bubble and (@) when hidden", async ({ browser }) => {
  clients = await joinRoom(browser, { roomUrl: testRoom("mention", "two").url, count: 2, nicknamePrefix: "mn" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("no clients");
  const input = a.page.locator(site.chatInput);
  await expect(input).toHaveAttribute("role", "combobox");
  await expect(input).toHaveAttribute("aria-expanded", "false");

  // Typing @ opens the list of everyone here but me; arrows move, Enter picks.
  await input.click();
  await input.pressSequentially("hey @");
  await expect(input).toHaveAttribute("aria-expanded", "true");
  const list = a.page.getByRole("listbox", { name: "Mention someone" });
  await expect(list.getByRole("option")).toHaveText([b.nickname]);
  await input.press("ArrowDown");
  await expect(input).toHaveAttribute("aria-activedescendant", (await list.getByRole("option").first().getAttribute("id")) ?? "");
  await input.press("Enter");
  await expect(input).toHaveValue(`hey @${b.nickname} `);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  // Escape closes the list without leaving the field.
  await input.pressSequentially("and @m");
  await expect(list).toBeVisible();
  await input.press("Escape");
  await expect(list).toBeHidden();
  await expect(input).toBeFocused();
  await input.fill(`hey @${b.nickname} look`);
  await input.press("Enter");

  // B: highlighted line and a ringed bubble. A: neither (it's not about A).
  const line = (p: Page) => p.locator(site.chatLogLine).filter({ hasText: "look" });
  await expect(line(b.page)).toHaveClass(/is-mention/);
  await expect(b.page.locator(".ui-float.is-mention")).toHaveCount(1);
  await expect(line(a.page)).not.toHaveClass(/is-mention/);
  await expect(a.page.locator(".ui-float.is-mention")).toHaveCount(0);

  // Hidden: plain chat counts, a mention shows as (@); looking back clears it.
  await setHidden(b.page, true);
  await a.page.locator(site.chatInput).fill("plain line");
  await a.page.locator(site.chatInput).press("Enter");
  await expect(b.page).toHaveTitle(/^\(1\) /);
  await a.page.locator(site.chatInput).fill(`${b.nickname.toUpperCase()} you there?`);
  await a.page.locator(site.chatInput).press("Enter");
  await expect(b.page).toHaveTitle(/^\(@\) /);
  await setHidden(b.page, false);
  await expect(b.page).not.toHaveTitle(/^\(/);
});
