// Reactions (OME-1631, Movie night): while something plays, the bar under the room sends `react` (click or Shift+1–4)
// and every client bursts a few glyphs over the sender's head (Smooth only). The bar takes from the emote bucket, so
// it cools after EMOTE_BURST reactions.
import { EMOTE_BURST } from "@omega/shared";
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { shareVideo, waitPlaying } from "../perf/sync";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Counts, from now on, every glyph shown in the room (a glyph lives 0.9 s: a poll alone could miss it). */
async function watchGlyphs(page: Page): Promise<void> {
  await page.evaluate(() => {
    let seen = 0;
    Reflect.set(window, "__glyphsSeen", () => seen);
    new MutationObserver((records) => {
      for (const r of records) if (r.target instanceof HTMLElement && r.target.classList.contains("reaction-glyph") && !r.target.hidden) seen++;
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement && n.classList.contains("reaction-glyph") && !n.hidden) seen++;
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["hidden"] });
  });
}

const glyphsSeen = (page: Page): Promise<number> =>
  page.evaluate(() => {
    const f: unknown = Reflect.get(window, "__glyphsSeen");
    return typeof f === "function" ? Number(Reflect.apply(f, window, [])) : 0;
  });

/** Two clients in a room that plays a video, both forced to Smooth (the glyphs' tier). */
async function playing(browser: Parameters<typeof joinRoom>[0], request: Parameters<typeof shareVideo>[0], name: "bar" | "burst"): Promise<{ a: Client; b: Client }> {
  const room = testRoom("reactions", name);
  await shareVideo(request, room.id);
  clients = await joinRoom(browser, {
    roomUrl: room.url,
    count: 2,
    nicknamePrefix: "react",
    setup: async (context) => {
      await context.addInitScript(() => {
        localStorage.setItem("omega.motion", "smooth");
      });
    },
  });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await waitPlaying(clients);
  return { a, b };
}

test("the bar shows while a video plays; a click and Shift+1–4 spend the emote bucket, then the bar cools", async ({ browser, request }) => {
  const { a } = await playing(browser, request, "bar");
  const bar = a.page.getByTestId("reaction-bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByRole("button", { name: "Wow" })).toHaveAttribute("aria-keyshortcuts", "Shift+3");
  await bar.getByRole("button", { name: "Heart" }).click();
  for (let i = 1; i < EMOTE_BURST; i++) await a.page.keyboard.press("Shift+Digit2");
  await expect(bar).toHaveClass(/is-cooling/);
  await expect(bar.getByRole("button", { name: "Clap" })).toHaveAttribute("aria-disabled", "true");
});

test("a reaction bursts glyphs over the sender for everyone", async ({ browser, request }) => {
  const { a, b } = await playing(browser, request, "burst");
  await watchGlyphs(b.page);
  await a.page.getByTestId("reaction-bar").getByRole("button", { name: "Heart" }).click();
  await expect.poll(() => glyphsSeen(b.page), { timeout: 5_000 }).toBeGreaterThan(0);
});
