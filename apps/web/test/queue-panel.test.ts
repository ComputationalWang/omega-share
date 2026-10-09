import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QUEUE_MAX, type ClientMessage, type Member, type QueueItem, type RoomState, type ServerMessage } from "@omega/shared";
import { initialState, reduce, type ViewState } from "../src/state";

beforeAll(() => {
  GlobalRegistrator.register();
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

// OME-508 (ADR 0031, set j "Up next"): the queue panel. Rows say what kind of source, a title, who added it and synced or not;
// a pasted link goes through the share parser before anything is sent; remove and "play next" follow the control policy.
// The panel redraws only when the queue (or who's in the room) changes, never per frame. Text only, and never an iframe.

const me: Member = { id: "me", nickname: "Ada", avatar: 0 };
const kit: Member = { id: "kit", nickname: "<b>Kit</b>", avatar: 3 };
const yt = (id: string) => ({ provider: "youtube", videoId: id, url: `https://www.youtube.com/embed/${id}` }) as const;
const live = { provider: "twitch", kind: "live", channel: "some_streamer", url: "https://player.twitch.tv/?channel=some_streamer" } as const;
const page = { provider: "generic", host: "example.org", url: "https://example.org/watch/1" } as const;
const item = (id: string, embed: QueueItem["embed"] = yt("dQw4w9WgXcQ"), by: string | null = "kit"): QueueItem => ({ id, embed, by });

function room(over: Partial<RoomState> = {}): RoomState {
  return { id: "r1", seats: [null, null, null, null, null, null, null, null], members: [me, kit], embed: yt("9bZkp7q19f0"), itemId: "now", queue: [], ...over };
}

async function setup(r: RoomState = room(), owner = false) {
  const { createQueuePanel } = await import("../src/controls/queue-panel");
  let state: ViewState = reduce(initialState, { type: "server", msg: { type: "snapshot", self: "me", room: r, owner }, now: 0 });
  const sent: ClientMessage[] = [];
  const net = { up: true };
  const panel = createQueuePanel({
    send: (m) => {
      if (!net.up) return false;
      sent.push(m);
      return true;
    },
    ownHosts: ["omega.example.net"],
  });
  document.body.replaceChildren(panel.root);
  panel.update(state);
  const server = (msg: ServerMessage): void => {
    state = reduce(state, { type: "server", msg, now: 0 });
    panel.update(state);
  };
  const q = <T extends HTMLElement = HTMLElement>(testId: string): T => {
    const e = panel.root.querySelector<T>(`[data-testid=${testId}]`);
    if (e === null) throw new Error(`no ${testId}`);
    return e;
  };
  const rows = (): HTMLElement[] => [...panel.root.querySelectorAll<HTMLElement>("[data-testid=queue-row]")];
  const paste = (url: string): void => {
    q<HTMLInputElement>("queue-url").value = url;
    q<HTMLFormElement>("queue-form").requestSubmit();
  };
  return { panel, sent, net, server, q, rows, paste, state: () => state };
}

describe("the list", () => {
  test("empty: the empty line and 0 / 20", async () => {
    const { q, rows } = await setup();
    expect(rows()).toHaveLength(0);
    expect(q("queue-count").textContent).toBe(`0 / ${String(QUEUE_MAX)}`);
    expect(q("queue-empty").hidden).toBe(false);
    expect(q("queue-empty").textContent).toContain("Nothing up next");
  });

  test("rows in play order: the first plays next; kind, title, who added it, synced or not", async () => {
    const { q, rows } = await setup(room({ queue: [item("a"), item("b", live, "me"), item("c", page, null)] }));
    expect(q("queue-count").textContent).toBe("3 / 20");
    expect(q("queue-empty").hidden).toBe(true);
    const [a, b, c] = rows();
    expect(rows().map((r) => r.classList.contains("is-next"))).toEqual([true, false, false]);
    expect(a?.querySelector(".ui-qsrc-video")).not.toBeNull();
    expect(b?.querySelector(".ui-qsrc-live")).not.toBeNull();
    expect(c?.querySelector(".ui-qsrc-generic")).not.toBeNull();
    expect(a?.querySelector(".title")?.textContent).toBe("YouTube video dQw4w9WgXcQ");
    expect(b?.querySelector(".title")?.textContent).toBe("Twitch: some_streamer (live)");
    expect(c?.querySelector(".title")?.textContent).toBe("example.org/watch/1");
    expect(a?.querySelector(".meta")?.textContent).toBe("<b>Kit</b>");
    expect(a?.querySelector(".ui-head-kiki")).not.toBeNull();
    expect(b?.querySelector(".meta")?.textContent).toBe("Ada (you)");
    expect(c?.querySelector(".meta")?.textContent).toBe("someone");
    expect(a?.querySelector(".ui-chip")?.textContent).toBe("Synced");
    expect(c?.querySelector(".ui-chip.solo")?.textContent).toBe("Not synced");
  });

  test("names are text, never markup; a generic item is never loaded from the panel", async () => {
    const { panel } = await setup(room({ queue: [item("a"), item("c", page)] }));
    expect(panel.root.querySelector("b")).toBeNull();
    expect(panel.root.querySelector("iframe")).toBeNull();
  });

  test("an adder who left reads 'someone'", async () => {
    const { rows, server } = await setup(room({ queue: [item("a")] }));
    server({ type: "member-left", memberId: "kit" });
    expect(rows()[0]?.querySelector(".meta")?.textContent).toBe("someone");
  });

  test("queue-changed redraws the rows", async () => {
    const { rows, server, q } = await setup(room({ queue: [item("a"), item("b")] }));
    server({ type: "queue-changed", queue: [item("b")], by: "kit" });
    expect(rows().map((r) => r.dataset["item"])).toEqual(["b"]);
    expect(q("queue-count").textContent).toBe("1 / 20");
  });
});

describe("renders once per change, never per frame", () => {
  test("chat, playback and ticks leave the panel alone; a queue change redraws it exactly once", async () => {
    const { panel, server, state } = await setup(room({ queue: [item("a")] }));
    const base = panel.renders();
    for (let i = 0; i < 60; i++) panel.update(state());
    server({ type: "chat", memberId: "kit", text: "hi" });
    server({ type: "playback", playback: { playing: false, position: 3, rate: 1, at: 1, rev: 5, action: "pause", by: "kit" } });
    server({ type: "member-status", memberId: "kit", catching: true });
    expect(panel.renders()).toBe(base);
    server({ type: "queue-changed", queue: [item("a"), item("b")], by: "kit" });
    for (let i = 0; i < 60; i++) panel.update(state());
    expect(panel.renders()).toBe(base + 1);
  });
});

describe("paste a link", () => {
  test("a video link is sent as queue-add with the raw url, and the field clears", async () => {
    const { sent, paste, q } = await setup();
    paste("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(sent).toEqual([{ type: "queue-add", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }]);
    expect(q<HTMLInputElement>("queue-url").value).toBe("");
    expect(q("queue-url").getAttribute("aria-invalid")).toBe("false");
  });

  test("another site's https page is accepted too (the generic tier decides on the server)", async () => {
    const { sent, paste } = await setup();
    paste("https://example.org/videos/42");
    expect(sent).toEqual([{ type: "queue-add", url: "https://example.org/videos/42" }]);
  });

  test("an empty field sends nothing and says nothing", async () => {
    const { sent, paste, q } = await setup();
    paste("   ");
    expect(sent).toEqual([]);
    expect(q("queue-problem").hidden).toBe(true);
  });

  test.each([
    ["not a link at all", "That isn't a link. Paste the address of a video page."],
    ["ftp://files.local/movie.mkv", "That link can't play here. Try a video page's https link."],
    ["http://example.org/video", "That link can't play here. Try a video page's https link."],
    ["https://192.168.1.4/video", "That link can't play here. Try a video page's https link."],
    ["https://omega.example.net/r/abc", "That's a link to this site. Paste a video page's link."],
  ])("%p is refused before sending, with the parser's reason", async (url, reason) => {
    const { sent, paste, q } = await setup();
    paste(url);
    expect(sent).toEqual([]);
    expect(q("queue-url").getAttribute("aria-invalid")).toBe("true");
    expect(q("queue-problem").hidden).toBe(false);
    expect(q("queue-problem").textContent).toBe(reason);
    expect(q<HTMLInputElement>("queue-url").value).toBe(url);
  });

  test("typing again clears the reason", async () => {
    const { paste, q } = await setup();
    paste("nope");
    const input = q<HTMLInputElement>("queue-url");
    input.value = "https://";
    input.dispatchEvent(new Event("input"));
    expect(q("queue-problem").hidden).toBe(true);
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  test("the server's refusal of an add shows under the field", async () => {
    const { paste, server, q } = await setup();
    paste("https://example.org/videos/42");
    server({ type: "error", code: "unsupported_url" });
    expect(q("queue-problem").textContent).toBe("That link can't be played in this room.");
    paste("https://example.org/videos/43");
    server({ type: "error", code: "rate_limited", retryAfterMs: 4000 });
    expect(q("queue-problem").textContent).toBe("Too many links at once. Try again in a few seconds.");
  });

  test("an error that isn't about my add doesn't show here", async () => {
    const { server, q } = await setup();
    server({ type: "error", code: "rate_limited", retryAfterMs: 1000 });
    expect(q("queue-problem").hidden).toBe(true);
  });

  test("a full queue: 20 / 20, Add off, the Full pill and what to do", async () => {
    const full = Array.from({ length: QUEUE_MAX }, (_, i) => item(`i${String(i)}`));
    const { q, paste, sent, server } = await setup(room({ queue: full }));
    expect(q("queue-count").textContent).toBe("20 / 20");
    expect(q<HTMLButtonElement>("queue-add").disabled).toBe(true);
    expect(q("queue-full").hidden).toBe(false);
    expect(q("queue-full").textContent).toContain("Remove one to add another");
    paste("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(sent).toEqual([]);
    server({ type: "queue-changed", queue: full.slice(1), by: "kit" });
    expect(q<HTMLButtonElement>("queue-add").disabled).toBe(false);
    expect(q("queue-full").hidden).toBe(true);
  });
});

describe("remove and play next follow the control policy", () => {
  test("× shows on my own rows and sends queue-remove; not on others' rows for a guest", async () => {
    const { rows, sent } = await setup(room({ queue: [item("a", yt("dQw4w9WgXcQ"), "kit"), item("b", yt("dQw4w9WgXcQ"), "me")] }));
    const [a, b] = rows();
    expect(a?.querySelector("[data-testid=queue-remove]")).toBeNull();
    const x = b?.querySelector<HTMLButtonElement>("[data-testid=queue-remove]");
    expect(x?.getAttribute("aria-label")).toBe("Remove YouTube video dQw4w9WgXcQ from the queue");
    x?.click();
    expect(sent).toEqual([{ type: "queue-remove", itemId: "b" }]);
  });

  test("the owner gets × on every row", async () => {
    const { rows } = await setup(room({ queue: [item("a"), item("b", yt("dQw4w9WgXcQ"), null)] }), true);
    expect(rows().map((r) => r.querySelector("[data-testid=queue-remove]") !== null)).toEqual([true, true]);
  });

  test("Play next sends queue-advance from the current item", async () => {
    const { q, sent } = await setup(room({ queue: [item("a")] }));
    expect(q("queue-next").hidden).toBe(false);
    q("queue-next").click();
    expect(sent).toEqual([{ type: "queue-advance", fromItemId: "now" }]);
  });

  test("Play next hides with nothing queued or no current item id", async () => {
    expect((await setup(room({ queue: [] }))).q("queue-next").hidden).toBe(true);
    const { itemId: _drop, ...noItem } = room({ queue: [item("a")] });
    expect((await setup(noItem)).q("queue-next").hidden).toBe(true);
  });

  test("only the host controls playback: a guest can't add, remove or skip, and is told why", async () => {
    const { q, rows, server } = await setup(room({ queue: [item("a", yt("dQw4w9WgXcQ"), "me")], controlPolicy: "owner" }));
    expect(rows()[0]?.querySelector("[data-testid=queue-remove]")).toBeNull();
    expect(q("queue-next").hidden).toBe(true);
    expect(q<HTMLInputElement>("queue-url").disabled).toBe(true);
    expect(q<HTMLButtonElement>("queue-add").disabled).toBe(true);
    expect(q("queue-held").hidden).toBe(false);
    server({ type: "control-policy-changed", policy: "everyone", by: "kit" });
    expect(q<HTMLInputElement>("queue-url").disabled).toBe(false);
    expect(q("queue-held").hidden).toBe(true);
    expect(rows()[0]?.querySelector("[data-testid=queue-remove]")).not.toBeNull();
  });

  test("the host keeps every key under the owner policy", async () => {
    const { q } = await setup(room({ queue: [item("a")], controlPolicy: "owner" }), true);
    expect(q("queue-next").hidden).toBe(false);
    expect(q<HTMLInputElement>("queue-url").disabled).toBe(false);
  });
});
