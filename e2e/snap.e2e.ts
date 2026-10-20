// /snap and the camera key (OME-1565): one polaroid PNG of the room canvas at 2× nearest-neighbour, downloaded locally.
// Privacy: the photo is the stage canvas and nothing else, so name tags, bubbles (DOM over it) and the video never show.
import type { Download, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
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

/** apps/web/src/snap.ts: the border around the photo and the bottom band, in PNG px. */
const BORDER = 24;
const BAND = 96;

/** Say a line, so a bubble and my tag are over the canvas when the photo is taken. */
async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
  await expect(page.locator(`${site.room} .bubbles`).getByText(text)).toBeVisible();
  await expect(page.locator(site.nicknameTag).first()).toBeVisible();
}

/** Copy the stage canvas as it is now, in the same task as `act`, so the photo can be compared with it pixel for pixel. */
async function snapWith(page: Page, act: "key" | "slash"): Promise<Download> {
  await expect(page.locator(`${site.room} canvas`)).toBeVisible();
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.evaluate((act) => {
      const scene = document.querySelector<HTMLCanvasElement>("[data-testid=room] canvas");
      if (scene === null) throw new Error("no stage canvas");
      const ref = document.createElement("canvas");
      ref.width = scene.width;
      ref.height = scene.height;
      ref.getContext("2d")?.drawImage(scene, 0, 0);
      Reflect.set(window, "__snapRef", ref);
      if (act === "key") document.querySelector<HTMLButtonElement>("[data-testid=snap-key]")?.click();
      else {
        const input = document.querySelector<HTMLInputElement>("[data-testid=chat-input]");
        if (input === null) throw new Error("no chat input");
        input.value = "/snap";
        input.form?.requestSubmit();
      }
    }, act),
  ]);
  // Nothing is uploaded: the photo is a blob: URL in this tab.
  expect(requests.filter((u) => !u.startsWith("blob:"))).toEqual([]);
  return download;
}

/** Decode the PNG in the page: its size, and how many photo pixels differ from the canvas copy at 2×. */
async function check(page: Page, download: Download): Promise<{ w: number; h: number; cw: number; ch: number; diff: number; room: number; band: boolean }> {
  const path = await download.path();
  const png = (await readFile(path)).toString("base64");
  return page.evaluate(
    async ([b64, border, band]) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const ref: unknown = Reflect.get(window, "__snapRef");
      if (!(ref instanceof HTMLCanvasElement)) throw new Error("no reference copy");
      const out = document.createElement("canvas");
      out.width = bmp.width;
      out.height = bmp.height;
      const ctx = out.getContext("2d");
      const rctx = ref.getContext("2d");
      if (ctx === null || rctx === null) throw new Error("no 2d context");
      ctx.drawImage(bmp, 0, 0);
      const got = ctx.getImageData(0, 0, out.width, out.height).data;
      const want = rctx.getImageData(0, 0, ref.width, ref.height).data;
      // The room's own pixels (the canvas is transparent around it, where the photo shows the page's backdrop).
      let diff = 0;
      let room = 0;
      for (let y = 0; y < ref.height * 2; y++) {
        for (let x = 0; x < ref.width * 2; x++) {
          const g = ((border + y) * out.width + border + x) * 4;
          const r = ((y >> 1) * ref.width + (x >> 1)) * 4;
          if (want[r + 3] !== 255) continue;
          room++;
          for (let c = 0; c < 4; c++) if (got[g + c] !== want[r + c]) {
            diff++;
            break;
          }
        }
      }
      // The band is off-white, with the title and date drawn on it: some dark pixels.
      const strip = ctx.getImageData(0, out.height - band, out.width, band).data;
      let dark = 0;
      for (let i = 0; i < strip.length; i += 4) if ((strip[i] ?? 255) < 128) dark++;
      return { w: bmp.width, h: bmp.height, cw: ref.width, ch: ref.height, diff, room, band: dark > 50 && (strip[0] ?? 0) > 200 };
    },
    [png, BORDER, BAND] as const,
  );
}

for (const act of ["key", "slash"] as const) {
  test(`${act === "key" ? "the camera key" : "/snap"} downloads omega-<date>.png: the canvas at 2× in a polaroid border, no tags, bubbles or uploads`, async ({ browser }) => {
    clients = await joinRoom(browser, { roomUrl: testRoom("snap", act).url, count: 1, nicknamePrefix: "snap" });
    const [a] = clients;
    if (a === undefined) throw new Error("need a client");
    if (act === "key") {
      // Its 44 px touch target (reference.css, under .ui-touch) is audited by the a11y sweep at 844x390-touch.
      await expect(a.page.locator(site.snapKey)).toHaveAccessibleName(/photo/i);
    }
    await say(a.page, "cheese");
    const download = await snapWith(a.page, act);
    expect(download.suggestedFilename()).toMatch(/^omega-\d{4}-\d{2}-\d{2}\.png$/);
    const r = await check(a.page, download);
    expect(r.cw).toBeGreaterThan(0);
    expect({ w: r.w, h: r.h }).toEqual({ w: r.cw * 2 + BORDER * 2, h: r.ch * 2 + BORDER + BAND });
    // Pixel for pixel the canvas: the DOM layers over it (tags, the "cheese" bubble) and the video aren't in it.
    expect(r.room).toBeGreaterThan(r.cw * r.ch);
    expect(r.diff).toBe(0);
    expect(r.band).toBe(true);
    // /snap is a command, not chat: no line went out.
    if (act === "slash") await expect(a.page.locator(site.chatLog).getByText("/snap")).toHaveCount(0);
  });
}
