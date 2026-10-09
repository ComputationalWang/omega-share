// Per-viewer video quality (OME-599, research R-M7b): a local choice, never synced, never on the wire.

/** One entry of the picker: `id` is what the provider's setter takes, `label` what the viewer reads. */
export interface QualityOption {
  readonly id: string;
  readonly label: string;
}

/**
 * The quality capability of a player. `options()` is empty when this video can't be set from our page
 * (the picker hides). The list can arrive or go away later; the adapter emits a `quality` event then.
 */
export interface QualityControl {
  options(): readonly QualityOption[];
  /** The id playing now; null if unknown. */
  current(): string | null;
  /** Ask for a listed id. Unlisted ids, and calls before ready or after destroy, do nothing. */
  set(id: string): void;
}

/** Bounds on what a provider's iframe can make us render. */
const MAX_OPTIONS = 16;
const MAX_TEXT = 40;

export const NO_QUALITIES: readonly QualityOption[] = [];

const text = (x: unknown): string | null => (typeof x === "string" && x !== "" && x.length <= MAX_TEXT ? x : null);

/**
 * Guard a provider's quality list: each entry is a string (id = label) or an object whose `idKey` is the id
 * and `labelKey` the label (falling back to the id). Anything else, and repeated ids, are dropped.
 */
export function parseQualities(list: unknown, idKey: string, labelKey: string): readonly QualityOption[] {
  if (!Array.isArray(list)) return NO_QUALITIES;
  const out: QualityOption[] = [];
  for (const q of list as readonly unknown[]) {
    if (out.length === MAX_OPTIONS) break;
    let id: string | null = null;
    let label: string | null = null;
    if (typeof q === "string") {
      id = text(q);
      label = id;
    } else if (typeof q === "object" && q !== null) {
      const r = q as Record<string, unknown>;
      id = text(r[idKey]);
      label = text(r[labelKey]) ?? id;
    }
    if (id === null || label === null || out.some((o) => o.id === id)) continue;
    out.push({ id, label });
  }
  return out.length === 0 ? NO_QUALITIES : out;
}

export function sameQualities(a: readonly QualityOption[], b: readonly QualityOption[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const y = b[i];
    if (a[i]?.id !== y?.id || a[i]?.label !== y?.label) return false;
  }
  return true;
}
