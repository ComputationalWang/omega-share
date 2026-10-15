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
  const cards = createRoomCards({ roomId: ROOM, serverUrl: "http://srv.test", secrets, owns, leave: () => undefined, reclaim: () => { reclaimed++; }, fetch: () => Promise.reject(new Error("offline")) });
  document.body.replaceChildren(...cards.cards, cards.foot);
  return { cards, secrets, reclaimed: () => reclaimed };
}

const card = (id: string): HTMLElement | null => document.querySelector(`[data-testid="${id}"]`);
const open: ViewState = { ...initialState, status: "open", room: null };

describe("room cards", () => {
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
});
