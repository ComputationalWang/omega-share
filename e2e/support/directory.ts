// The room directory sits behind the profile step (Dusk doorstep, OME-935): a nickname, then "Find or create a room".
// A returning profile (a nickname saved in this browser) lands on the directory straight away.
import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";
import { site } from "./selectors";

/** On `/`: open the directory (create form, your rooms, open rooms), through the profile step if it shows. */
export async function openDirectory(page: Page, nickname = "Visitor"): Promise<void> {
  const form = page.locator(site.createRoomForm);
  const find = page.locator(site.findRoom);
  await expect(form.or(find)).toBeVisible();
  if (await find.isVisible()) {
    await page.locator(site.nicknameInput).fill(nickname);
    await find.click();
  }
  await expect(form).toBeVisible();
}
