import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { GenericTv } from "../src/controls/generic-tv";
import type { ExtensionBridge } from "../src/extension-bridge";
import type { TvGeneric } from "../src/tv";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  // No page loads inside iframes: the test must never reach the network.
  GlobalRegistrator.register({ url: "https://omega.example/r/main", settings: { navigation: { disableChildFrameNavigation: true } } });
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const FRAME: TvGeneric = {
  kind: "generic",
  key: "https://media.example.org/embed/42",
  host: "media.example.org",
  src: "https://media.example.org/embed/42",
  sandbox: "allow-scripts allow-same-origin allow-presentation",
  allow: "fullscreen; autoplay",
  referrerPolicy: "no-referrer",
  title: "Shared video from media.example.org",
};

/** Messages the page posted to the extension, newest last; reset by `make`. */
let posted: unknown[] = [];

async function make(frame: TvGeneric = FRAME, bridge?: ExtensionBridge): Promise<GenericTv> {
  const { createGenericTv } = await import("../src/controls/generic-tv");
  const tv = createGenericTv(frame, bridge ?? (await newBridge()));
  // Attached, as in the room: a connected iframe is the one that would load.
  document.body.replaceChildren(tv.screen, tv.strip);
  return tv;
}

async function newBridge(): Promise<ExtensionBridge> {
  posted = [];
  window.postMessage = (msg: unknown) => {
    posted.push(msg);
  };
  const { createExtensionBridge } = await import("../src/extension-bridge");
  return createExtensionBridge(window);
}

/** A message as the extension's content script posts it; `origin`/`source` override for the negative cases. */
function deliver(data: unknown, origin: string = location.origin, source: MessageEventSource | null = window): void {
  window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
}
const PRESENT = { source: "omega-share", kind: "present", version: "1.4.0" };
const unlockResult = (outcome: string) => ({ source: "omega-share", kind: "unlock-result", host: "media.example.org", outcome });
const byId = (tv: GenericTv, id: string): HTMLElement | null => tv.screen.querySelector<HTMLElement>(`[data-testid=${id}]`);

function loadButton(tv: GenericTv): HTMLButtonElement {
  const b = tv.screen.querySelector<HTMLButtonElement>("[data-testid=generic-load]");
  if (b === null) throw new Error("no Load button");
  return b;
}

describe("generic embed TV (ADR 0024 §3)", () => {
  test("before Load: a card with the host, 'not synced' and Load, and nothing that fetches", async () => {
    const tv = await make();
    expect(tv.screen.querySelectorAll("iframe")).toHaveLength(0);
    expect(document.querySelectorAll("iframe, img, link, script, object, embed, video, audio, source")).toHaveLength(0);
    expect(tv.screen.textContent).toContain("media.example.org");
    expect(tv.screen.textContent.toLowerCase()).toContain("not synced");
    expect(loadButton(tv).textContent).toBe("Load");
    expect(tv.loaded()).toBe(false);
  });

  test("Load renders exactly one iframe with the ADR's fixed attributes and nothing else", async () => {
    const tv = await make();
    loadButton(tv).click();
    const frames = tv.screen.querySelectorAll("iframe");
    expect(frames).toHaveLength(1);
    const f = frames[0];
    if (f === undefined) throw new Error("no iframe");
    expect(Object.fromEntries([...f.attributes].map((a) => [a.name, a.value]))).toEqual({
      src: "https://media.example.org/embed/42",
      sandbox: "allow-scripts allow-same-origin allow-presentation",
      allow: "fullscreen; autoplay",
      referrerpolicy: "no-referrer",
      title: "Shared video from media.example.org",
      "data-testid": "shared-video",
    });
    expect(tv.screen.querySelector("[data-testid=generic-load]")).toBeNull();
    expect(tv.loaded()).toBe(true);
  });

  test("the host goes in as text, never markup", async () => {
    const tv = await make({ ...FRAME, host: "<img src=x>" });
    expect(tv.screen.querySelectorAll("img")).toHaveLength(0);
    expect(tv.screen.textContent).toContain("<img src=x>");
  });

  test("a small 'not synced' label stays visible after Load, with the can't-embed hint", async () => {
    const tv = await make();
    const label = tv.strip.querySelector<HTMLElement>("[data-testid=not-synced]");
    expect(label?.hidden).toBe(false);
    expect(label?.textContent.toLowerCase()).toContain("not synced");
    const hint = tv.strip.querySelector<HTMLElement>("[data-testid=generic-hint]");
    expect(hint?.hidden).toBe(true);
    loadButton(tv).click();
    expect(label?.hidden).toBe(false);
    expect(hint?.hidden).toBe(false);
    // Short enough to show whole in the strip; the tooltip names the host, so "this site" can't read as ours.
    expect(hint?.textContent).toBe("Blank/error: host blocks it");
    expect(hint?.title).toBe("Blank or an error page? media.example.org doesn't allow playing its videos here.");
  });

  describe("unlock with extension (ADR 0047 §1, §5)", () => {
    test("without the extension: no Unlock button, and the card says some hosts need it", async () => {
      const tv = await make();
      expect(byId(tv, "generic-unlock")).toBeNull();
      expect(byId(tv, "generic-ext-hint")?.textContent).toBe("Some hosts only play here with the Omega Share extension.");
      expect(byId(tv, "generic-ext-hint")?.hidden).toBe(false);
    });

    test("present from another origin or source changes nothing", async () => {
      const tv = await make();
      deliver(PRESENT, "https://evil.example");
      deliver(PRESENT, location.origin, null);
      expect(byId(tv, "generic-unlock")).toBeNull();
    });

    test("after present: Unlock with extension next to Load, and the extension hint goes", async () => {
      const tv = await make();
      deliver(PRESENT);
      expect(byId(tv, "generic-unlock")?.textContent).toBe("Unlock with extension");
      expect(byId(tv, "generic-ext-hint")?.hidden).toBe(true);
      expect(loadButton(tv).parentElement).toBe(byId(tv, "generic-unlock")?.parentElement ?? null);
    });

    test("a card made after present shows Unlock at once", async () => {
      const bridge = await newBridge();
      deliver(PRESENT);
      const tv = await make(FRAME, bridge);
      expect(byId(tv, "generic-unlock")).not.toBeNull();
    });

    test("Unlock posts unlock for the parsed host and creates the iframe only after unlocked", async () => {
      const tv = await make();
      deliver(PRESENT);
      byId(tv, "generic-unlock")?.click();
      expect(posted).toEqual([{ source: "omega-share", kind: "unlock", host: "media.example.org" }]);
      expect(tv.screen.querySelectorAll("iframe")).toHaveLength(0);
      deliver(unlockResult("unlocked"));
      await Promise.resolve();
      const f = tv.screen.querySelector("iframe");
      expect(f?.getAttribute("src")).toBe("https://media.example.org/embed/42");
      expect(f?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation");
      expect(f?.getAttribute("referrerpolicy")).toBe("no-referrer");
      expect(tv.loaded()).toBe(true);
    });

    test("denied or unsupported: a one-line status, Load stays, no iframe", async () => {
      for (const outcome of ["denied", "unsupported"]) {
        const tv = await make();
        deliver(PRESENT);
        byId(tv, "generic-unlock")?.click();
        deliver(unlockResult(outcome));
        await Promise.resolve();
        expect(tv.screen.querySelectorAll("iframe")).toHaveLength(0);
        expect(byId(tv, "generic-unlock-status")?.hidden).toBe(false);
        expect(byId(tv, "generic-unlock-status")?.textContent).toContain("media.example.org");
        expect(loadButton(tv).disabled).toBe(false);
      }
    });

    test("a consent tab closed without an answer: back on the room, Unlock works again", async () => {
      const tv = await make();
      deliver(PRESENT);
      const unlock = (): HTMLButtonElement | null => tv.screen.querySelector<HTMLButtonElement>("[data-testid=generic-unlock]");
      unlock()?.click();
      expect(unlock()?.disabled).toBe(true);
      // The extension never answers; the viewer comes back to the room tab.
      window.dispatchEvent(new Event("focus"));
      expect(unlock()?.disabled).toBe(false);
      unlock()?.click();
      expect(posted).toHaveLength(2);
      deliver(unlockResult("unlocked"));
      await Promise.resolve();
      expect(tv.screen.querySelectorAll("iframe")).toHaveLength(1);
    });
  });
});
