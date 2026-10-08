// The real specs' room view (OME-378): a production build has no window.__omega, so they read the room from the DOM.
// On a dev build both sources are there, and the DOM reading must agree with __omega in every state the specs record.
import { expect, test } from "./support/csp";
import type { Page } from "@playwright/test";
import { PENDING, available } from "./support/apps";
import { joinRoom, leaveAll, testRoom, type Client } from "./support/room";
import { site } from "./support/selectors";
import { PAUSED, fakeState, shareVideo, waitPlaying } from "../perf/sync";
import { joinReady, roomView, type RoomView } from "./real/room-view";

test.fixme(!available.web, PENDING.web);
test.fixme(!available.server, PENDING.server);

const fields = ({ playing, catching, live, seekOnly, canControl, error }: RoomView) => ({ playing, catching, live, seekOnly, canControl, error });

/** Polls until the DOM reading agrees with the __omega reading, then returns it. */
async function agreed(page: Page): Promise<ReturnType<typeof fields>> {
  const read = async () => {
    const [dev, dom] = await Promise.all([roomView(page), roomView(page, "dom")]);
    return { sources: [dev.source, dom.source], dev: fields(dev), dom: fields(dom), agree: JSON.stringify(fields(dev)) === JSON.stringify(fields(dom)) };
  };
  await expect.poll(read, { timeout: 5_000 }).toMatchObject({ sources: ["dev", "dom"], agree: true });
  return (await read()).dom;
}

let clients: Client[] = [];
test.afterEach(async () => {
  await leaveAll(clients);
  clients = [];
});

test("DOM room view matches __omega: playing, self catching (ad), paused; join readiness without __omega", async ({ browser, request }) => {
  const room = testRoom("room-view", "main");
  await shareVideo(request, room.id);
  clients = await joinRoom(browser, { roomUrl: room.url, count: 2, nicknamePrefix: "view" });
  const [a, b] = clients;
  if (a === undefined || b === undefined) throw new Error("need two clients");
  await waitPlaying(clients);

  expect(await agreed(a.page)).toEqual({ playing: true, catching: false, live: false, seekOnly: false, canControl: true, error: null });

  await a.page.evaluate(() => window.__fakeYt?.ad(4000));
  expect(await agreed(a.page)).toMatchObject({ playing: true, catching: true });
  await expect(b.page.locator(`${site.nicknameTag}.catching`)).toHaveText(["view-1"]);
  await expect.poll(async () => (await roomView(a.page, "dom")).catching, { timeout: 10_000 }).toBe(false);

  await a.page.locator(site.playToggle).click();
  await expect.poll(() => fakeState(b.page)).toBe(PAUSED);
  expect(await agreed(a.page)).toMatchObject({ playing: false, catching: false });

  // A production build: no __omega at all. The view says where it read from, and the landing page reports ready.
  await a.page.evaluate(() => { delete window.__omega; });
  expect(await roomView(a.page)).toMatchObject({ source: "dom", playing: false });
  const fresh = await a.context.newPage();
  await fresh.addInitScript(() => { Object.defineProperty(window, "__omega", { set() {}, get: () => undefined }); });
  await fresh.goto(room.url);
  await expect.poll(() => fresh.evaluate(joinReady)).toBe(true);
  expect(await fresh.evaluate(() => window.__omega)).toBeUndefined();
});
