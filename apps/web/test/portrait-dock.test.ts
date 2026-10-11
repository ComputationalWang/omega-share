import { afterAll, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

beforeAll(() => { GlobalRegistrator.register(); });
afterAll(async () => { await GlobalRegistrator.unregister(); });

test("sharing opens the existing queue in a sheet and closing returns focus to its link key", async () => {
  const { createPortraitDock } = await import("../src/portrait-dock");
  const root = document.createElement("section");
  const log = document.createElement("ol");
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  const composer = document.createElement("form");
  const field = document.createElement("input");
  composer.append(field);
  const queue = document.createElement("section");
  const url = document.createElement("input");
  queue.append(url);
  root.append(log, composer, queue);
  document.body.replaceChildren(root);
  const dock = createPortraitDock({ root, log, composer, queue, settings: [] });
  dock.setActive(true);
  dock.link.click();
  expect(dock.sheet.open).toBe(true);
  expect(dock.sheet.contains(queue)).toBe(true);
  expect(document.activeElement).toBe(url);
  dock.close();
  expect(queue.parentElement).toBe(root);
  expect(document.activeElement).toBe(dock.link);
  expect(log.getAttribute("aria-live")).toBe("polite");
});

test("portrait room gives up its crop height before pushing the composer below the viewport", async () => {
  const { portraitLayout } = await import("../src/layout");
  const full = portraitLayout(360, 430, null, false);
  expect(full.height).toBe(430);
  expect(full.stage.h).toBeGreaterThan(0);
  const keyboard = portraitLayout(360, 260, null, true);
  expect(keyboard.stage.h).toBe(0);
  expect(keyboard.controls.h).toBe(0);
  expect(keyboard.tv.h).toBe(203);
  expect(keyboard.height).toBe(260);
});
