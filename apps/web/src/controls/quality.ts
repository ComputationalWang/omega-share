// This device's video quality per provider (OME-599, research R-M7b): local only, never on the wire.
import type { Provider } from "@omega/shared";

export const QUALITY_KEY_PREFIX = "omega.quality.";
/** Twitch groups and Vimeo ids are short (`720p60`, `chunked`, `auto`); anything else isn't one of ours. */
const MAX_ID = 40;

export interface QualityMemory {
  load(provider: Provider): string | null;
  save(provider: Provider, id: string): void;
}

/** A `localStorage`-like store; its methods may throw (blocked storage). */
export interface QualityStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Printable, 1–40 characters: what a provider's quality id looks like. */
const valid = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_ID && /^[\x20-\x7e]+$/.test(v);

/** localStorage is untrusted (anyone can edit it): a value that doesn't parse reads as none. Never throws. */
export function qualityMemory(store: QualityStore): QualityMemory {
  return {
    load(provider) {
      try {
        const v = store.getItem(QUALITY_KEY_PREFIX + provider);
        return valid(v) ? v : null;
      } catch {
        return null;
      }
    },
    save(provider, id) {
      if (!valid(id)) return;
      try {
        store.setItem(QUALITY_KEY_PREFIX + provider, id);
      } catch {
        // Storage off (private mode): the choice lasts for this page only.
      }
    },
  };
}
