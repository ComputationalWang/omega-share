// Holiday themes (OME-1186, ADR 0052): which theme a viewer's local date gets. Client-only: nothing travels, so a clock a
// day off may see a different theme at a boundary. Pure.
import * as v from "valibot";

export const THEME_IDS = ["halloween", "sinterklaas", "christmas", "valentine", "easter"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

/** Fixed periods as month*100+day, both ends inclusive (plan OME-1140). Easter is computed per year. */
const FIXED: readonly (readonly [ThemeId, number, number])[] = [
  ["valentine", 210, 214],
  ["halloween", 1024, 1101],
  ["sinterklaas", 1114, 1206],
  ["christmas", 1207, 1231],
];

/** Western Easter Sunday (Anonymous Gregorian algorithm, Meeus/Jones/Butcher); `month` 1–12. */
export function easterSunday(year: number): { month: number; day: number } {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return { month, day };
}

/** Whole days since the epoch for a calendar date (UTC arithmetic, so no DST hour shifts it). */
const dayNumber = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 86_400_000;

/** The theme of `date`'s local calendar day, or null. */
export function activeTheme(date: Date): ThemeId | null {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const md = m * 100 + d;
  for (const [id, from, to] of FIXED) if (md >= from && md <= to) return id;
  const easter = easterSunday(y);
  const offset = dayNumber(y, m, d) - dayNumber(y, easter.month, easter.day);
  return offset >= -7 && offset <= 1 ? "easter" : null;
}

const OverrideSchema = v.picklist([...THEME_IDS, "off"]);

/** `localStorage["omega.theme"]`: a theme id forces it, `off` turns themes off, anything else is ignored. */
export function resolveTheme(date: Date, override: string | null): ThemeId | null {
  const o = v.safeParse(OverrideSchema, override);
  if (!o.success) return activeTheme(date);
  return o.output === "off" ? null : o.output;
}
