// /hug and /highfive (OME-1453): walk over to someone with the existing `walk`, then the existing `emote` on arrival.
// Outfit slots (OME-1453): three "Save outfit / Wear" slots in the People panel, kept in localStorage; Wear sends only
// what changed (`set-tint`, `set-hair`, `set-accessory`), and says so in the slot when the avatar can't change in-room.
import * as v from "valibot";
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

const Sent = v.object({ type: v.string(), kind: v.optional(v.string()), tint: v.optional(v.number()), hair: v.optional(v.number()), accessory: v.optional(v.number()) });
type Sent = v.InferOutput<typeof Sent>;

/** Every message `page` sends from now on, parsed, in order. */
function recordSent(page: Page): Sent[] {
  const sent: Sent[] = [];
  page.on("websocket", (ws) =>
    ws.on("framesent", (f) => {
      if (typeof f.payload !== "string") return;
      const m = v.safeParse(Sent, JSON.parse(f.payload));
      if (m.success && m.output.type !== "ping" && m.output.type !== "typing") sent.push(m.output);
    }),
  );
  return sent;
}

async function say(page: Page, text: string): Promise<void> {
  await page.locator(site.chatInput).fill(text);
  await page.locator(site.chatInput).press("Enter");
}

test("/hug walks me over, then sends a heart on arrival; an unknown name is a local hint", async ({ browser }) => {
  const sent: Sent[][] = [];
  clients = await joinRoom(browser, {
    roomUrl: testRoom("hug", "walk").url,
    count: 2,
    nicknamePrefix: "hug",
    setup: (context, i) => {
      if (i === 0) context.on("page", (p) => sent.push(recordSent(p)));
      return Promise.resolve();
    },
  });
  const [a, b] = clients;
  const frames = sent[0];
  if (a === undefined || b === undefined || frames === undefined) throw new Error("need two clients");
  await expect(a.page.locator(site.nicknameTag)).toHaveCount(2);

  await say(a.page, "/hug nobody-here");
  await expect(a.page.locator(site.chatLogLine).last()).toContainText("Nobody here is called nobody-here");
  expect(frames.filter((m) => m.type === "walk" || m.type === "emote")).toEqual([]);

  await say(a.page, "/hug HUG-2");
  await expect.poll(() => frames.filter((m) => m.type === "walk").length).toBe(1);
  // Not on the click: only once the walk ends.
  expect(frames.some((m) => m.type === "emote")).toBe(false);
  await expect.poll(() => frames.filter((m) => m.type === "emote"), { timeout: 15_000 }).toEqual([{ type: "emote", kind: "heart" }]);
  expect(frames.findIndex((m) => m.type === "walk")).toBeLessThan(frames.findIndex((m) => m.type === "emote"));
});

test("Wear puts a saved outfit back on, sending only what changed; another avatar's outfit says so in its slot", async ({ browser }) => {
  const sent: Sent[][] = [];
  clients = await joinRoom(browser, {
    roomUrl: testRoom("outfit", "wear").url,
    count: 1,
    nicknamePrefix: "outfit",
    setup: async (context) => {
      context.on("page", (p) => sent.push(recordSent(p)));
      // Slot 3 holds another avatar's outfit (joinRoom picks avatar 0 for the first client).
      await context.addInitScript(() => {
        localStorage.setItem("omega.outfits", JSON.stringify([null, null, { avatar: 1, tint: 1, hair: 0, accessory: 0 }]));
      });
    },
  });
  const [a] = clients;
  const frames = sent[0];
  if (a === undefined || frames === undefined) throw new Error("need a client");
  await a.page.locator(site.peopleKey).click();
  await a.page.getByTestId("outfits").locator("summary").click();
  const slots = a.page.getByTestId("outfit-slot");
  await expect(slots).toHaveCount(3);

  // Shirt 3 and hair 2, saved in slot 1.
  await a.page.getByTestId("tint-menu").getByRole("radio").nth(3).click();
  await a.page.getByTestId("hair-menu").getByRole("radio").nth(2).click();
  await slots.nth(0).getByRole("button", { name: "Save outfit 1" }).click();
  expect(JSON.parse((await a.page.evaluate(() => localStorage.getItem("omega.outfits"))) ?? "null")).toEqual([{ avatar: 0, tint: 3, hair: 2, accessory: 0 }, null, { avatar: 1, tint: 1, hair: 0, accessory: 0 }]);

  // Change shirt and accessory, then wear slot 1: shirt and accessory go back, hair didn't change so isn't sent.
  await a.page.getByTestId("tint-menu").getByRole("radio").nth(5).click();
  await a.page.getByTestId("accessory-menu").getByRole("radio").nth(1).click();
  frames.length = 0;
  await slots.nth(0).getByRole("button", { name: "Wear outfit 1" }).click();
  await expect.poll(() => frames).toEqual([
    { type: "set-tint", tint: 3 },
    { type: "set-accessory", accessory: 0 },
  ]);
  await expect(a.page.getByTestId("tint-menu").getByRole("radio").nth(3)).toHaveAttribute("aria-checked", "true");

  // Slot 3's avatar can't be put on in a room: it says so, and wears the rest.
  frames.length = 0;
  await slots.nth(2).getByRole("button", { name: "Wear outfit 3" }).click();
  await expect(slots.nth(2)).toContainText("Avatar is picked when you join");
  await expect.poll(() => frames).toEqual([
    { type: "set-tint", tint: 1 },
    { type: "set-hair", hair: 0 },
  ]);
});
