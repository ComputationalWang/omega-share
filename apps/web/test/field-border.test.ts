import { describe, expect, test } from "bun:test";

// WCAG 1.4.11 (OME-1242): a text field's border is a UI component boundary and needs 3:1 against what it sits on.
const css = await Bun.file(new URL("../src/style.css", import.meta.url)).text();
const roomCss = await Bun.file(new URL("../src/room.css", import.meta.url)).text();
const sheets = { "style.css": css, "room.css": roomCss };
// The three CSS text fields (OME-1242 round 1): each draws the token and keeps a focus ring that stands off it.
const fields = [
  ["style.css", ".invite input"],
  ["room.css", ".chat input"],
  ["room.css", ".popout-chat input"],
] as const;

function rule(sheet: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(sheet)?.[1] ?? "";
}

function token(name: string): string {
  const hex = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})\\b`).exec(css)?.[1];
  if (hex === undefined) throw new Error(`${name} is not a #rrggbb token in style.css`);
  return hex;
}

function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const v = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("--field-border (style.css)", () => {
  test("the formula matches WCAG: white on black is 21:1", () => {
    expect(contrast("#ffffff", "#000000")).toBeCloseTo(21, 5);
  });
  for (const surface of ["--panel", "--bg"]) {
    test(`reaches 3:1 against ${surface}`, () => {
      expect(contrast(token("--field-border"), token(surface))).toBeGreaterThanOrEqual(3);
    });
  }
});

describe("text fields use --field-border", () => {
  for (const [name, sheet] of Object.entries(sheets)) {
    test(`${name} has no old #554d73 border`, () => {
      expect(sheet.toLowerCase()).not.toContain("#554d73");
    });
  }
  for (const [name, selector] of fields) {
    test(`${selector} (${name}) borders with var(--field-border)`, () => {
      expect(rule(sheets[name], selector)).toContain("border: 1px solid var(--field-border)");
    });
    test(`${selector} (${name}) has its own focus-visible ring`, () => {
      expect(rule(sheets[name], `${selector}:focus-visible`)).toContain("outline: 2px solid var(--ui-text)");
    });
  }
});
