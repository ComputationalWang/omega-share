import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import type { GenericTv } from "../src/controls/generic-tv";
import type { TvGeneric } from "../src/tv";

// A real DOM for this file only; the other web tests stay DOM-free.
beforeAll(() => {
  // No page loads inside iframes: the test must never reach the network.
  GlobalRegistrator.register({ settings: { navigation: { disableChildFrameNavigation: true } } });
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

async function make(frame: TvGeneric = FRAME): Promise<GenericTv> {
  const { createGenericTv } = await import("../src/controls/generic-tv");
  const tv = createGenericTv(frame);
  // Attached, as in the room: a connected iframe is the one that would load.
  document.body.replaceChildren(tv.screen, tv.strip);
  return tv;
}

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
    expect(hint?.textContent).toBe("Blank? This site doesn't allow embedding.");
  });
});
