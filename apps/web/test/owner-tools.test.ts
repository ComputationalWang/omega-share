import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { Member, RoomState } from "@omega/shared";
import { Container } from "pixi.js";
import type { ChatLogEntry } from "../src/chat/log";
import { initialState, reduce, type ViewState } from "../src/state";

// OME-1100: the owner's "Edit room" key and moderation tools, split out of room.ts. Only the owner of an open room on a
// computer gets the key; a phone gets one "arrange it on a computer" line instead.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const OWNER = "o".repeat(21) + "A";
const me: Member = { id: "me", nickname: "host", avatar: 0 };
const ROOM: RoomState = { id: "r1", seats: [null, null, null, null], members: [me], embed: null };

async function setup(o: { owns?: boolean; phone?: boolean } = {}) {
  const { createOwnerTools } = await import("../src/owner-tools");
  const bar = document.createElement("div");
  const lines: ChatLogEntry[] = [];
  let state: ViewState = initialState;
  const tools = createOwnerTools({
    ownerToken: o.owns === false ? undefined : OWNER,
    roomId: ROOM.id,
    serverUrl: "http://srv.test",
    stage: document.createElement("div"),
    tags: document.createElement("div"),
    view: { editLayer: new Container(), redraw: () => undefined },
    anchor: () => undefined,
    bar,
    panel: document.createElement("div"),
    state: () => state,
    send: () => true,
    requestRender: () => undefined,
    phone: () => o.phone === true,
    roomOut: () => false,
    log: (e) => lines.push(e),
  });
  const render = (s: ViewState): void => {
    state = s;
    tools.render(s);
  };
  return { tools, bar, lines, render };
}

const openOwned: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "me", room: ROOM, owner: true }, now: 0 });
const editKey = (bar: HTMLElement): HTMLButtonElement | null => bar.querySelector<HTMLButtonElement>('[data-testid="edit-room"]');

describe("owner tools", () => {
  test("the owner of an open room on a computer gets the Edit room key", async () => {
    const { bar, render } = await setup();
    render(openOwned);
    expect(editKey(bar)?.textContent).toContain("Edit room");
    expect(editKey(bar)?.disabled).toBe(false);
  });

  test("a guest gets no key at all", async () => {
    const { bar, render } = await setup({ owns: false });
    render(openOwned);
    expect(editKey(bar)).toBeNull();
  });

  test("on a phone: no key, and one line saying to arrange the room on a computer", async () => {
    const { bar, lines, render } = await setup({ phone: true });
    render(openOwned);
    render(openOwned);
    expect(editKey(bar)).toBeNull();
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines[0])).toContain("Arrange the room on a computer.");
  });

  test("no draft to preview until the editor is open", async () => {
    const { tools, render } = await setup();
    render(openOwned);
    expect(tools.preview()).toBeNull();
  });
});
