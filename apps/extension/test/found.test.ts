import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Window } from "happy-dom";
import { FOUND_ORIGINS, FOUND_SCRIPT_ID, RECHECK_MS, actionState, checkPage, parseFoundMessage, syncFound, throttle } from "../src/found";

// OME-1042: the opt-in "video found" toolbar indicator.
const PAGES = join(import.meta.dirname, "../../../e2e/fixtures/pages");

function load(name: string, url: string): Document {
  const window = new Window({
    url,
    settings: { disableIframePageLoading: true, disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true },
  });
  window.document.write(readFileSync(join(PAGES, `${name}.html`), "utf8"));
  return window.document as unknown as Document;
}

describe("checkPage", () => {
  test("a page with embeds sends only their count, never a URL", () => {
    const message = checkPage(load("youtube-embed", "https://blog.example/post"), []);
    expect(message).toEqual({ kind: "omega-found", count: 1 });
  });

  test("a YouTube watch page counts itself", () => {
    expect(checkPage(load("no-video", "https://www.youtube.com/watch?v=aqz-KE-bpKQ"), [])).toEqual({ kind: "omega-found", count: 1 });
  });

  test("a page with nothing shareable counts 0", () => {
    expect(checkPage(load("no-video", "https://blog.example/post"), [])).toEqual({ kind: "omega-found", count: 0 });
  });
});

describe("parseFoundMessage", () => {
  test.each([
    [{ kind: "omega-found", count: 3 }, 3],
    [{ kind: "omega-found", count: 0 }, 0],
    [{ kind: "omega-found", count: -1 }, null],
    [{ kind: "omega-found", count: 1.5 }, null],
    [{ kind: "omega-found", count: "1" }, null],
    [{ kind: "unlock", count: 1 }, null],
    [null, null],
    ["omega-found", null],
  ])("%j → %p", (raw, expected) => {
    expect(parseFoundMessage(raw)).toBe(expected);
  });
});

describe("actionState", () => {
  test("found: the lit-lamp icon, the count on the badge, and a title that says it (OME-1287)", () => {
    expect(actionState(2)).toEqual({
      path: { 16: "icon/found-16.png", 32: "icon/found-32.png", 48: "icon/found-48.png", 64: "icon/found-64.png" },
      title: "omega share: 2 videos found",
      badge: "2",
    });
    expect(actionState(1)).toMatchObject({ title: "omega share: 1 video found", badge: "1" });
  });

  test("nothing: back to the idle icon and title", () => {
    expect(actionState(0)).toEqual({
      path: { 16: "icon/16.png", 32: "icon/32.png", 48: "icon/48.png", 64: "icon/idle-64.png" },
      title: "omega share",
      badge: "",
    });
  });
});

/** A clock the test moves by hand. */
function fakeClock() {
  let now = 0;
  let timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      timers.push({ at: now + ms, fn });
    },
    advance(ms: number) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      for (const t of due) t.fn();
    },
  };
}

describe("throttle", () => {
  test("the recheck interval is at least 1 s", () => {
    expect(RECHECK_MS).toBeGreaterThanOrEqual(1000);
  });

  test("runs at once, then at most once per interval, with one trailing run for a burst", () => {
    const clock = fakeClock();
    let runs = 0;
    const trigger = throttle(() => runs++, 1000, clock);
    trigger();
    expect(runs).toBe(1);
    clock.advance(10);
    trigger();
    trigger();
    trigger();
    expect(runs).toBe(1);
    clock.advance(989);
    expect(runs).toBe(1);
    clock.advance(1);
    expect(runs).toBe(2);
    clock.advance(5000);
    expect(runs).toBe(2);
    trigger();
    expect(runs).toBe(3);
  });
});

describe("syncFound", () => {
  function harness(granted: boolean) {
    const calls: string[] = [];
    let registered: unknown;
    const deps = {
      granted: () => Promise.resolve(granted),
      register: (script: unknown) => {
        registered = script;
        calls.push("register");
        return Promise.resolve();
      },
      unregister: (id: string) => {
        calls.push(`unregister ${id}`);
        return Promise.reject(new Error("not registered"));
      },
      resetIcons: () => {
        calls.push("reset");
        return Promise.resolve();
      },
    };
    return { deps, calls, registered: () => registered };
  }

  test("granted: registers the content script on https pages at document_idle, never on our own site", async () => {
    const h = harness(true);
    await syncFound(h.deps, ["https://omega.example/*"]);
    expect(h.calls).toEqual([`unregister ${FOUND_SCRIPT_ID}`, "register"]);
    expect(h.registered()).toEqual({
      id: FOUND_SCRIPT_ID,
      js: ["content-scripts/found.js"],
      matches: [...FOUND_ORIGINS],
      excludeMatches: ["https://omega.example/*"],
      runAt: "document_idle",
      persistAcrossSessions: false,
    });
  });

  test("not granted (toggle off or revoked): unregisters and clears every tab's indicator", async () => {
    const h = harness(false);
    await syncFound(h.deps, []);
    expect(h.calls).toEqual([`unregister ${FOUND_SCRIPT_ID}`, "reset"]);
  });
});
