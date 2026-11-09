import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { initialState, type ViewState } from "../src/state";
import { loadRoomSecrets, rememberRoom } from "../src/room-secrets";

// OME-1100: the cards that take the room's place (full, refused, closed, removed, replaced, not found) and the guest's
// report foot, split out of room.ts. Each one shows from the view state alone.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const ROOM = "abcdefghijklmnopqrstuvwxyz";
const OWNER = "o".repeat(21) + "A";

class MemoryStore {
  readonly data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, value: string): void {
    this.data.set(k, value);
  }
}

async function setup(owns = false) {
  const { createRoomCards } = await import("../src/room-cards");
  const secrets = new MemoryStore();
  rememberRoom(secrets, ROOM, { ownerToken: OWNER });
  let reclaimed = 0;
  let took = 0;
  const cards = createRoomCards({ roomId: ROOM, serverUrl: "http://srv.test", secrets, owns, leave: () => undefined, reclaim: () => { reclaimed++; }, useThisTab: () => { took++; }, fetch: () => Promise.reject(new Error("offline")) });
  document.body.replaceChildren(...cards.cards, cards.foot);
  return { cards, secrets, reclaimed: () => reclaimed, took: () => took };
}

const card = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const open: ViewState = { ...initialState, status: "open", room: null };

describe("room cards", () => {
  // OME-2282: shown only at the first render, the guest's report key took 35 px from the room's column as the room came
  // in, and the TV and the room moved up (cold-load CLS). It's laid out from the start; an owner never gets one.
  test("a guest's report foot is laid out before the first render; an owner has none", async () => {
    expect((await setup()).cards.foot.hidden).toBe(false);
    expect((await setup(true)).cards.foot.hidden).toBe(true);
  });

  test("a taken-down room says so and forgets this browser's keys for it", async () => {
    const { cards, secrets } = await setup();
    cards.render({ ...initialState, status: "taken-down" });
    expect(card("room-closed")?.hidden).toBe(false);
    expect(card("room-closed")?.dataset["reason"]).toBe("taken-down");
    expect(card("room-closed")?.textContent).toContain("after a report");
    expect(loadRoomSecrets(secrets).rooms[ROOM]).toBeUndefined();
    expect(card("room-foot")?.hidden).toBe(true);
  });

  test("a replaced session shows Return here with focus, and the key reclaims it", async () => {
    const { cards, reclaimed } = await setup();
    cards.render({ ...initialState, status: "replaced" });
    const back = card("room-replaced-return");
    expect(card("room-replaced")?.hidden).toBe(false);
    expect(document.activeElement).toBe(back);
    back?.click();
    expect(reclaimed()).toBe(1);
  });

  test("a guest in an open room gets the report key; an owner gets none", async () => {
    const guest = await setup();
    guest.cards.render(open);
    expect(card("room-foot")?.hidden).toBe(false);
    expect(card("room-foot")?.childElementCount).toBeGreaterThan(0);
    const owner = await setup(true);
    owner.cards.render({ ...open, owner: true });
    expect(card("room-foot")?.hidden).toBe(true);
    expect(card("room-foot")?.childElementCount).toBe(0);
    expect(owner.cards.reportOpen()).toBe(false);
  });

  test("a refused join names why", async () => {
    const { cards } = await setup();
    cards.render({ ...initialState, status: "refused", refusal: "nickname_taken" });
    expect(card("room-refused")?.hidden).toBe(false);
    expect(card("room-refused")?.dataset["code"]).toBe("nickname_taken");
  });

  // OME-2429: no stop is a dead end, and focus never drops to <body> when a card takes the room's place.
  test("room full offers Try again, focused, and Find a room", async () => {
    const { cards } = await setup();
    cards.render({ ...initialState, status: "full" });
    const full = card("room-full");
    expect(full?.hidden).toBe(false);
    const retry = card("room-full-retry");
    expect(retry?.textContent).toBe("Try again");
    expect(retry?.getAttribute("href")).toBe(location.pathname);
    expect(document.activeElement).toBe(retry);
    const find = full?.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(find?.textContent).toBe("Find a room");
  });

  test("a removal puts focus on Find a room", async () => {
    const { cards } = await setup();
    cards.render({ ...initialState, status: "kicked", kickedUntil: Date.now() + 120_000 });
    const find = card("room-kicked")?.querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(find?.textContent).toBe("Find a room");
    expect(document.activeElement).toBe(find);
  });

  test("a refused join puts focus on its way out", async () => {
    const { cards } = await setup();
    cards.render({ ...initialState, status: "refused", refusal: "too_many_members" });
    expect(document.activeElement).toBe(card("room-refused-action"));
  });

  test("open in another tab of this browser: Use this tab takes the session over instead of navigating", async () => {
    const { cards, took } = await setup();
    cards.render({ ...initialState, status: "refused", refusal: "open_elsewhere" });
    expect(card("room-refused")?.textContent).toContain("open in another tab");
    const use = card("room-refused-action");
    expect(use?.textContent).toBe("Use this tab");
    expect(document.activeElement).toBe(use);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    use?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(took()).toBe(1);
  });

  test("an ordinary refusal's link is left to navigate", async () => {
    const { cards, took } = await setup();
    cards.render({ ...initialState, status: "refused", refusal: "nickname_taken" });
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    card("room-refused-action")?.addEventListener("click", (e) => { e.preventDefault(); }, { once: true });
    card("room-refused-action")?.dispatchEvent(click);
    expect(took()).toBe(0);
  });
});
