// Holiday themes (OME-1186, ADR 0052): which theme a viewer's local date gets. Stub.
export const THEME_IDS = ["halloween", "sinterklaas", "christmas", "valentine", "easter"] as const;
export type ThemeId = (typeof THEME_IDS)[number];

export function easterSunday(_year: number): { month: number; day: number } {
  return { month: 0, day: 0 };
}

export function activeTheme(_date: Date): ThemeId | null {
  return null;
}

export function resolveTheme(_date: Date, _override: string | null): ThemeId | null {
  return null;
}
