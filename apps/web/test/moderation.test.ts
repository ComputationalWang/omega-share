import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { ClientMessage, Member, RoomState, ServerMessage } from "@omega/shared";
import { initialState, reduce, type ViewState } from "../src/state";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-507 (ADR 0030, set j "house rules"): the owner's moderation tools, in the lazy owner chunk. A member's name tag opens
// a menu (Mute / Unmute chat, Remove from room, which asks first); the bar holds "Who controls playback". Text only.

const me: Member = { id: "me", nickname: "host", avatar: 0 };
const kit: Member = { id: "kit", nickname: "Kit", avatar: 3 };
const mo: Member = { id: "mo", nickname: "<b>Mo</b>", avatar: 2 };
const room: RoomState = { id: "r1", seats: [null, null, null, null, null, null, null, null], members: [me, kit, mo], embed: null };

async function setup(owner = true) {
  const { mountModeration } = await import("../src/owner/moderation");
  let state: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "me", room, owner }, now: 0 });
  const stage = document.createElement("div");
  const tags = document.createElement("div");
  const bar = document.createElement("div");
  stage.append(tags);
  document.body.replaceChildren(stage, bar);
  // Name tags as room.ts draws them: one span per member with data-member, the nickname as text.
  for (const m of room.members) {
    const t = document.createElement("span");
    t.className = "tag ui-tag";
    t.dataset["member"] = m.id;
    if (m.id === "me") t.classList.add("self");
    const n = document.createElement("span");
    n.className = "tag-name";
    n.textContent = m.nickname;
    t.append(n);
    tags.append(t);
  }
  const sent: ClientMessage[] = [];
  let anchorAt = { x: 400, y: 310 };
  const mod = mountModeration({
    stage,
    tags,
    bar,
    view: () => state,
    send: (m) => {
      sent.push(m);
      return true;
    },
    anchor: () => anchorAt,
    stageWidth: 960,
  });
  const tag = (id: string): HTMLElement => {
    const t = tags.querySelector<HTMLElement>(`[data-member="${id}"]`);
    if (t === null) throw new Error(`no tag ${id}`);
    return t;
  };
  const menu = (): HTMLElement | null => stage.querySelector<HTMLElement>("[data-testid=mod-menu]");
  const row = (testId: string): HTMLElement => {
    const b = stage.querySelector<HTMLElement>(`[data-testid=${testId}]`);
    if (b === null) throw new Error(`no ${testId}`);
    return b;
  };
  const server = (msg: ServerMessage): void => {
    state = reduce(state, { type: "server", msg, now: 0 });
    mod.update();
  };
  mod.update();
  const setAnchor = (p: { x: number; y: number }): void => {
    anchorAt = p;
  };
  return { mod, sent, tag, tags, bar, menu, row, server, stage, setAnchor };
}

describe("member menu", () => {
  test("others' name tags become menu buttons for the owner; my own never does", async () => {
    const { tag } = await setup();
    expect(tag("kit").getAttribute("role")).toBe("button");
    expect(tag("kit").tabIndex).toBe(0);
    expect(tag("kit").getAttribute("aria-haspopup")).toBe("dialog");
    expect(tag("me").getAttribute("role")).toBeNull();
  });

  test("clicking a tag opens that member's menu: their name as text, Mute chat and Remove from room", async () => {
    const { tag, menu, stage } = await setup();
    tag("mo").click();
    const m = menu();
    expect(m).not.toBeNull();
    // A small dialog of plain buttons (the Remove row grows Keep / Remove keys, which a menuitem can't hold).
    expect(m?.getAttribute("role")).toBe("dialog");
    expect(m?.getAttribute("aria-label")).toBe("<b>Mo</b>");
    expect(tag("mo").getAttribute("aria-expanded")).toBe("true");
    expect(m?.querySelector(".name")?.textContent).toBe("<b>Mo</b>");
    expect(m?.querySelector("b")).toBeNull();
    expect(m?.querySelector(".ui-portrait-mo")).not.toBeNull();
    expect([...stage.querySelectorAll(".ui-modrow")].map((e) => e.textContent)).toEqual(["Mute chat", "Remove from room"]);
    expect(stage.querySelector("[data-testid=mod-remove] button")?.textContent).toBe("Remove from room");
  });

  test("clicking my own tag opens nothing", async () => {
    const { tag, menu } = await setup();
    tag("me").click();
    expect(menu()).toBeNull();
  });

  test("Mute chat sends mute and closes; once muted the row offers Unmute chat, and the tag carries the zip", async () => {
    const { tag, menu, row, sent, server } = await setup();
    tag("kit").click();
    row("mod-mute").click();
    expect(sent).toEqual([{ type: "mute", memberId: "kit", muted: true }]);
    expect(menu()).toBeNull();
    server({ type: "member-muted", memberId: "kit", muted: true });
    expect(tag("kit").querySelector(".ui-glyph-chat-mute")).not.toBeNull();
    tag("kit").click();
    expect(row("mod-mute").textContent).toBe("Unmute chat");
    row("mod-mute").click();
    expect(sent.at(-1)).toEqual({ type: "mute", memberId: "kit", muted: false });
    server({ type: "member-muted", memberId: "kit", muted: false });
    expect(tag("kit").querySelector(".ui-glyph-chat-mute")).toBeNull();
  });

  test("Remove asks first (\"Remove Kit for 10 min?\"); Keep backs out, Remove sends kick", async () => {
    const { tag, menu, row, sent, stage } = await setup();
    tag("kit").click();
    stage.querySelector<HTMLButtonElement>("[data-testid=mod-remove] button")?.click();
    expect(sent).toEqual([]);
    expect(row("mod-remove").classList.contains("is-ask")).toBe(true);
    expect(row("mod-remove").textContent).toContain("Remove Kit for 10 min?");
    row("mod-keep").click();
    expect(sent).toEqual([]);
    expect(row("mod-remove").classList.contains("is-ask")).toBe(false);
    stage.querySelector<HTMLButtonElement>("[data-testid=mod-remove] button")?.click();
    row("mod-confirm").click();
    expect(sent).toEqual([{ type: "kick", memberId: "kit" }]);
    expect(menu()).toBeNull();
  });

  test("Escape and the close key close the menu", async () => {
    const { mod, tag, menu, row } = await setup();
    tag("kit").click();
    expect(mod.key(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(true);
    expect(menu()).toBeNull();
    expect(mod.key(new KeyboardEvent("keydown", { key: "Escape" }))).toBe(false);
    tag("kit").click();
    row("mod-close").click();
    expect(menu()).toBeNull();
  });

  test("closing hands focus back to the member's tag", async () => {
    const { mod, tag } = await setup();
    tag("kit").focus();
    tag("kit").click();
    mod.key(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.activeElement).toBe(tag("kit"));
    expect(tag("kit").getAttribute("aria-expanded")).toBe("false");
  });

  test("a press outside the menu and the tags closes it; a press inside doesn't", async () => {
    const { tag, menu, stage, bar } = await setup();
    tag("kit").click();
    menu()?.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).not.toBeNull();
    bar.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
    tag("kit").click();
    stage.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  test("the open menu follows its member when they move", async () => {
    const { mod, tag, menu, setAnchor } = await setup();
    tag("kit").click();
    const before = menu()?.style.transform;
    setAnchor({ x: 500, y: 250 });
    mod.update();
    expect(menu()?.style.transform).not.toBe(before);
    expect(menu()?.style.transform).toBe("translate(500px, 244px)");
  });

  test("Enter on a focused tag opens its menu (keyboard)", async () => {
    const { tag, menu } = await setup();
    tag("kit").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(menu()).not.toBeNull();
  });

  test("the menu closes when its member leaves (kicked or not)", async () => {
    const { tag, menu, server } = await setup();
    tag("kit").click();
    server({ type: "member-left", memberId: "kit", reason: "kicked" });
    expect(menu()).toBeNull();
  });

  test("destroy removes the menu, the setting and the tag decorations", async () => {
    const { mod, tag, menu, bar } = await setup();
    tag("kit").click();
    mod.destroy();
    expect(menu()).toBeNull();
    expect(bar.children.length).toBe(0);
    expect(tag("kit").getAttribute("role")).toBeNull();
    tag("kit").click();
    expect(menu()).toBeNull();
  });
});

describe("who controls playback", () => {
  const tiles = (bar: HTMLElement) => [...bar.querySelectorAll<HTMLButtonElement>("[role=radio]")];

  test("two tiles, Everyone checked by default, with what it means", async () => {
    const { bar } = await setup();
    const t = tiles(bar);
    expect(t.map((b) => b.textContent)).toEqual(["Everyone", "Only me"]);
    expect(t.map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    expect(bar.textContent).toContain("Who controls playback");
    expect(bar.textContent).toContain("Anyone in the room can play, pause and skip.");
  });

  test("Only me sends control-policy owner; the tiles follow the server's control-policy-changed, not the click", async () => {
    const { bar, sent, server } = await setup();
    tiles(bar)[1]?.click();
    expect(sent).toEqual([{ type: "control-policy", policy: "owner" }]);
    expect(tiles(bar).map((b) => b.getAttribute("aria-checked"))).toEqual(["true", "false"]);
    server({ type: "control-policy-changed", policy: "owner", by: "me" });
    expect(tiles(bar).map((b) => b.getAttribute("aria-checked"))).toEqual(["false", "true"]);
    expect(bar.textContent).toContain("Only you can play, pause and skip.");
  });

  test("radio keys: only the checked tile is in the tab order; arrows pick the other one", async () => {
    const { bar, sent, server } = await setup();
    expect(tiles(bar).map((b) => b.tabIndex)).toEqual([0, -1]);
    tiles(bar)[0]?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(sent).toEqual([{ type: "control-policy", policy: "owner" }]);
    server({ type: "control-policy-changed", policy: "owner", by: "me" });
    expect(tiles(bar).map((b) => b.tabIndex)).toEqual([-1, 0]);
    expect(document.activeElement).toBe(tiles(bar)[1]);
  });

  test("picking the policy that's already set sends nothing", async () => {
    const { bar, sent } = await setup();
    tiles(bar)[0]?.click();
    expect(sent).toEqual([]);
  });
});

describe("text only", () => {
  test("nothing is built from HTML strings", async () => {
    const src = await Bun.file(new URL("../src/owner/moderation.ts", import.meta.url)).text();
    expect(src).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  });
});
