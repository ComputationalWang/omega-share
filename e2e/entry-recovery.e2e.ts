import { expect, test } from "./support/csp";
import { PENDING, URLS, available } from "./support/apps";
import { site } from "./support/selectors";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

test("blocked localStorage still lets a guest open the directory and enter the lobby", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      get: () => { throw new DOMException("Site storage is blocked", "SecurityError"); },
    });
  });
  await page.goto(URLS.web);
  await expect(page.locator(site.joinButton)).toBeEnabled();
  await page.locator(site.nicknameInput).fill("storage-guest");
  await page.getByTestId("find-room").click();
  await expect(page.getByRole("heading", { name: "Open rooms", exact: true })).toBeVisible();
  await page.getByTestId("edit-profile").click();
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.chatInput)).toBeEnabled();
});

test("a failed room chunk offers Reload and the guest can enter afterwards", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const chunk = /\/src\/room\.ts(?:\?.*)?$|\/assets\/room-[A-Za-z0-9_-]{8}\.js$/;
  let armed = false;
  await page.route(chunk, (route) => armed ? route.abort() : route.continue());
  await page.goto(URLS.web);
  armed = true;
  await page.locator(site.nicknameInput).fill("room-retry");
  await page.locator(site.joinButton).click();
  await expect(page.locator("#nickname-error")).toContainText("Could not load the room.");
  const reload = page.getByRole("button", { name: "Reload", exact: true });
  await expect(reload).toBeVisible();
  await expect(reload).toHaveAttribute("type", "button");
  await page.unroute(chunk);
  await Promise.all([page.waitForEvent("load"), reload.click()]);
  // The saved nickname opens the directory on `/`; Edit profile returns to the Enter lobby form.
  await page.getByTestId("edit-profile").click();
  await expect(page.locator(site.nicknameInput)).toHaveValue("room-retry");
  await page.locator(site.joinButton).click();
  await expect(page.locator(site.room)).toBeVisible();
  await expect(page.locator(site.chatInput)).toBeEnabled();
  expect(errors).toEqual([]);
});

for (const name of ["home", "preset-thumbs"]) {
  test(`a failed ${name} chunk offers Reload and the directory opens afterwards`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const chunk = new RegExp(`/src/${name}\\.ts(?:\\?.*)?$|/assets/${name}-[A-Za-z0-9_-]{8}\\.js$`);
    let armed = false;
    await page.route(chunk, (route) => armed ? route.abort() : route.continue());
    await page.goto(URLS.web);
    armed = true;
    await page.locator(site.nicknameInput).fill("directory-retry");
    await page.getByTestId("find-room").click();
    await expect(page.locator("#directory")).toContainText("Could not load the directory.");
    const reload = page.locator("#directory").getByRole("button", { name: "Reload", exact: true });
    await expect(reload).toBeVisible();
    await expect(reload).toHaveAttribute("type", "button");
    await page.unroute(chunk);
    await Promise.all([page.waitForEvent("load"), reload.click()]);
    await expect(page.getByRole("heading", { name: "Open rooms", exact: true })).toBeVisible();
    await expect(page.locator("#directory")).not.toContainText("Could not load the directory.");
    expect(errors).toEqual([]);
  });
}
