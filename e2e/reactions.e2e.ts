// Reactions (OME-1631, Movie night): while something plays, the bar under the room sends `react` (click or Shift+1–4)
// and every client bursts a few glyphs over the sender's head (Smooth only). The bar takes from the emote bucket, so
// it cools after EMOTE_BURST reactions.
import { EMOTE_BURST } from "@omega/shared";
import { expect, test } from "./support/csp";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { shareVideo, waitPlaying } from "../perf/sync";
import { glyphsSeen, roomGlyphs, watchGlyphs } from "./support/glyphs";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

/** Two clients in a room that plays a video, both forced to Smooth (the glyphs' tier). */
async function playing(browser: Parameters<typeof joinRoom>[0], request: Parameters<typeof shareVideo>[0], name: "bar" | "burst" | "painted"): Promise<{ a: Client; b: Client }> {
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

test("a glyph is painted on the canvas, not in the DOM: its box holds pixels the room lacks once it is gone", async ({ browser, request }) => {
  const { a, b } = await playing(browser, request, "painted");
  await expect(b.page.locator(".reaction-glyph, .reactions")).toHaveCount(0);
  await a.page.getByTestId("reaction-bar").getByRole("button", { name: "Heart" }).click();
  await expect.poll(async () => (await roomGlyphs(b.page)).length, { timeout: 5_000 }).toBeGreaterThan(0);
  const glyphs = await roomGlyphs(b.page);
  expect(glyphs.every((g) => g.kind === "heart")).toBe(true);
  const withGlyphs = await b.page.screenshot();
  await expect.poll(async () => (await roomGlyphs(b.page)).length, { timeout: 5_000 }).toBe(0);
  const without = await b.page.screenshot();
  const rect = glyphs[0]?.rect;
  if (rect === undefined) throw new Error("no glyph");
  const changed = await b.page.evaluate(
    async ({ s, h, r }) => {
      const px = async (b64: string): Promise<{ d: Uint8ClampedArray; w: number }> => {
        const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0))], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d");
        if (g === null) throw new Error("no 2d");
        g.drawImage(bmp, 0, 0);
        return { d: g.getImageData(0, 0, bmp.width, bmp.height).data, w: bmp.width };
      };
      const [p, q] = [await px(s), await px(h)];
      let n = 0;
      // A little wider than the box: the screenshot lags the glyph's rise by a step or two.
      for (let y = Math.ceil(r.y) - 4; y < Math.floor(r.y + r.height) + 4; y++)
        for (let x = Math.ceil(r.x) - 4; x < Math.floor(r.x + r.width) + 4; x++) {
          const i = (y * p.w + x) * 4;
          if (p.d[i] !== q.d[i] || p.d[i + 1] !== q.d[i + 1] || p.d[i + 2] !== q.d[i + 2]) n++;
        }
      return n;
    },
    { s: withGlyphs.toString("base64"), h: without.toString("base64"), r: rect },
  );
  expect(changed).toBeGreaterThan(20);
});
