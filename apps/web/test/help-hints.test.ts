import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// OME-1587: the first-visit tour. Three chips, one after another, near the floor, the message field and People. "Got it"
// moves on, "Skip" (or Esc) ends it. Seen once per device (`omega.hints`, parsed); the Help dialog can start it again.
// A status, never a modal: it doesn't take focus or block the room.

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function memoryStore(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, value: string) => {
      m.set(k, value);
    },
    map: m,
  };
}

const blocked = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: (): void => {
    throw new Error("SecurityError");
  },
};

async function setup(store: ReturnType<typeof memoryStore> | typeof blocked = memoryStore()) {
  const { createHints } = await import("../src/help/hints");
  const anchors = [document.createElement("div"), document.createElement("form"), document.createElement("button")];
  // happy-dom lays nothing out: each anchor reports a box, as on a real page.
  for (const a of anchors) a.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 200, width: 300, height: 100 });
  const after = document.createElement("button");
  // The TV (empty until a test says otherwise, no box until a test gives it one) and the picture it's in.
  const tv = { box: document.createElement("div"), empty: true, picture: document.createElement("div"), message: document.createElement("button") };
  const asked: number[] = [];
  const hints = createHints({
    storage: store,
    anchor: (step) => {
      asked.push(step);
      return anchors[step] ?? null;
    },
    tv: { box: tv.box, empty: () => tv.empty, picture: tv.picture, message: tv.message },
    next: () => after,
  });
  document.body.replaceChildren(...anchors, tv.picture, tv.box, hints.root, after);
  const key = (id: string) => hints.root.querySelector<HTMLButtonElement>(`button[data-testid=${id}]`);
  return { hints, store, after, asked, key, tv };
}

describe("parseHints: what `omega.hints` says (localStorage is untrusted)", () => {
  test("nothing stored, or anything that isn't ours, reads as not seen", async () => {
    const { parseHints } = await import("../src/help/hints");
    for (const raw of [null, "", "1", "true", "{", "[]", "null", '{"seen":"yes"}', '{"seen":1}', '{"seen":false}', '{}']) {
      expect(parseHints(raw)).toEqual({ seen: false });
    }
  });

  test("what the tour writes reads back as seen", async () => {
    const { parseHints } = await import("../src/help/hints");
    expect(parseHints('{"seen":true}')).toEqual({ seen: true });
  });
});

describe("the first-visit tour", () => {
  test("hidden until the room shows it; then the first chip, about the floor, next to the floor", async () => {
    const { hints, asked } = await setup();
    expect(hints.root.hidden).toBe(true);
    hints.show();
    expect(hints.isOpen()).toBe(true);
    expect(hints.root.hidden).toBe(false);
    expect(hints.root.textContent).toContain("Click the floor to walk, double-click to jog");
    expect(asked).toContain(0);
  });

  test("a status, not a dialog: role=status, no aria-modal, and it never takes focus", async () => {
    const { hints } = await setup();
    const field = document.createElement("input");
    document.body.append(field);
    field.focus();
    hints.show();
    expect(hints.root.getAttribute("role")).toBe("status");
    expect(hints.root.hasAttribute("aria-modal")).toBe(false);
    expect(document.activeElement).toBe(field);
  });

  test("Got it walks the three chips, each placed by its own anchor, and the last one ends the tour", async () => {
    const { hints, asked, key } = await setup();
    hints.show();
    key("hint-next")?.click();
    expect(hints.root.textContent).toContain("Type / for commands, or open ✦");
    expect(asked).toContain(1);
    key("hint-next")?.click();
    expect(hints.root.textContent).toContain("Pick colours and a hat in People");
    expect(asked).toContain(2);
    key("hint-next")?.click();
    expect(hints.isOpen()).toBe(false);
    expect(hints.root.hidden).toBe(true);
  });

  test("Skip ends the tour from any chip", async () => {
    const { hints, key } = await setup();
    hints.show();
    key("hint-next")?.click();
    key("hint-skip")?.click();
    expect(hints.isOpen()).toBe(false);
    expect(hints.root.hidden).toBe(true);
  });

  test("seen once per device: it writes `omega.hints`, and the next room (or a reload) shows nothing", async () => {
    const store = memoryStore();
    const first = await setup(store);
    first.hints.show();
    expect(store.map.get("omega.hints")).toBe('{"seen":true}');
    const second = await setup(store);
    second.hints.show();
    expect(second.hints.isOpen()).toBe(false);
  });

  test("garbage in `omega.hints` reads as not seen: the tour shows", async () => {
    const { hints } = await setup(memoryStore({ "omega.hints": "<script>" }));
    hints.show();
    expect(hints.isOpen()).toBe(true);
  });

  test("blocked storage: it still shows on this page, and nothing throws", async () => {
    const { hints } = await setup(blocked);
    expect(() => {
      hints.show();
    }).not.toThrow();
    expect(hints.isOpen()).toBe(true);
  });

  test("show() is asked once per page (the room calls it on every render): after a skip it stays gone", async () => {
    const { hints, key } = await setup();
    hints.show();
    key("hint-skip")?.click();
    hints.show();
    expect(hints.isOpen()).toBe(false);
  });

  test("a dismiss() before it ever showed (no stage yet) doesn't use up the show", async () => {
    const { hints } = await setup();
    hints.dismiss();
    hints.show();
    expect(hints.isOpen()).toBe(true);
  });

  test("restart() (Show tips again) starts from the first chip, even on a device that has seen it", async () => {
    const { hints, key } = await setup(memoryStore({ "omega.hints": '{"seen":true}' }));
    hints.show();
    expect(hints.isOpen()).toBe(false);
    hints.restart();
    expect(hints.isOpen()).toBe(true);
    expect(hints.root.textContent).toContain("Click the floor to walk");
    key("hint-next")?.click();
    hints.restart();
    expect(hints.root.textContent).toContain("Click the floor to walk");
  });

  test("ending it from its own key hands focus to the next key, never to <body> or the hidden chip", async () => {
    const { hints, after, key } = await setup();
    hints.show();
    key("hint-skip")?.focus();
    key("hint-skip")?.click();
    expect(document.activeElement).toBe(after);
  });

  test("Got it keeps focus on the chip's Got it key while there's a next chip", async () => {
    const { hints, key } = await setup();
    hints.show();
    key("hint-next")?.focus();
    key("hint-next")?.click();
    expect(document.activeElement).toBe(key("hint-next"));
  });

  test("an anchor with no box (the stage behind People on a phone) hides the chip, never pins it to the viewport's top over the room bar; it's back once the anchor is", async () => {
    const { hints, key, after } = await setup();
    const floor = document.querySelector("div");
    if (floor === null) throw new Error("no anchor");
    hints.show();
    expect(hints.root.style.visibility).toBe("");
    expect(hints.root.style.top).toBe("192px");
    key("hint-next")?.focus();
    floor.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    window.dispatchEvent(new Event("resize"));
    expect(hints.root.style.visibility).toBe("hidden");
    expect(document.activeElement).toBe(after);
    expect(hints.isOpen()).toBe(true);
    floor.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 200, width: 300, height: 100 });
    window.dispatchEvent(new Event("resize"));
    expect(hints.root.style.visibility).toBe("");
  });

  test("a chip may sit on an empty TV; once the TV shows something it goes under the picture, out of sight if that's on the TV too, back when the TV is empty (OME-1778)", async () => {
    const { hints, tv } = await setup();
    // The anchors' chips (y 192 above, 308 below) are all on this TV.
    tv.box.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 400 });
    tv.picture.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
    hints.show();
    expect(hints.root.style.top).toBe("192px");
    // A video arrives: the TV's screen is swapped, no resize (Twitch's player must never start covered).
    tv.empty = false;
    tv.box.replaceChildren(document.createElement("iframe"));
    await Promise.resolve();
    expect(hints.root.style.visibility).toBe("");
    expect(hints.root.style.top).toBe("608px");
    tv.box.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 2000 });
    window.dispatchEvent(new Event("resize"));
    expect(hints.root.style.visibility).toBe("hidden");
    expect(hints.isOpen()).toBe(true);
    tv.empty = true;
    tv.box.replaceChildren(document.createElement("p"));
    await Promise.resolve();
    expect(hints.root.style.visibility).toBe("");
    expect(hints.root.style.top).toBe("192px");
  });

  test("on an empty TV a chip never covers its message: it goes under the picture instead (OME-2104)", async () => {
    const { hints, tv } = await setup();
    tv.box.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 400 });
    tv.picture.getBoundingClientRect = () => DOMRect.fromRect({ x: 0, y: 0, width: 800, height: 600 });
    // The message sits where the floor chip (y 192 above its anchor) would go.
    tv.message.getBoundingClientRect = () => DOMRect.fromRect({ x: 100, y: 180, width: 600, height: 40 });
    hints.show();
    expect(hints.root.style.visibility).toBe("");
    expect(hints.root.style.top).toBe("608px");
  });
});
