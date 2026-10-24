import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import config from "../vite.config";

// The empty-TV curtain tiles (OME-1812, design OME-1799 §5) are lazy art: files the browser fetches when the curtain
// shows, never data: URLs in the room's eager CSS (Vite inlines anything under 4 KB by default).
const inline = config({ command: "build", mode: "production" }).build?.assetsInlineLimit;

describe("lazy art stays files", () => {
  test.each(["curtain-pelmet", "curtain-drape", "curtain-hem", "curtain-seam"])("ui/scenes/%s.png is never inlined", (name) => {
    expect(typeof inline).toBe("function");
    if (typeof inline !== "function") return;
    expect(inline(`/repo/assets/ui/scenes/${name}.png`, Buffer.alloc(150))).toBe(false);
  });

  test("room.css draws the curtain from the four tiles", () => {
    const css = readFileSync(new URL("../src/room.css", import.meta.url), "utf8");
    for (const name of ["pelmet", "drape", "hem", "seam"]) expect(css).toContain(`assets/ui/scenes/curtain-${name}.png`);
  });
});
