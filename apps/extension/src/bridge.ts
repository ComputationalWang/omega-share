import * as v from "valibot";
import { ExtensionToPageSchema, PageToExtensionSchema, type ExtensionToPage, type PageToExtension } from "@omega/shared/extension-bridge";
import { hostPermissionPattern, parseServerBaseUrl } from "./settings";

/** The parts of a `MessageEvent` the bridge reads. */
export interface PageEvent {
  readonly source: unknown;
  readonly origin: string;
  readonly data: unknown;
}

/** A page → extension message, only from our own window on our origin (ADR 0047 §5); null for anything else. */
export function fromPage(event: PageEvent, self: unknown, origin: string): PageToExtension | null {
  if (event.source !== self || event.origin !== origin) return null;
  const parsed = v.safeParse(PageToExtensionSchema, event.data);
  return parsed.success ? parsed.output : null;
}

/** An extension → page message from the background, parsed before it reaches the page. */
export function fromBackground(raw: unknown): ExtensionToPage | null {
  const parsed = v.safeParse(ExtensionToPageSchema, raw);
  return parsed.success ? parsed.output : null;
}

/** Where the bridge runs: the default server origin, plus the stored self-hosted one when it is valid. */
export function bridgeMatches(defaultOrigin: string, stored: unknown): string[] {
  const own = typeof stored === "string" ? parseServerBaseUrl(stored) : null;
  const origins = own?.ok === true ? [defaultOrigin, own.origin] : [defaultOrigin];
  return [...new Set(origins.map(hostPermissionPattern))];
}
